#!/usr/bin/env bun
// aidlc-copilot-adapter.ts — the GitHub Copilot hook shim (AUTHORED shell
// file; the aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared
// with the Claude Code harness). Modeled on codex's aidlc-codex-adapter.ts:
// ONE shim normalizes the harness payload to the ClaudeCodeHookInput shape
// and subprocess-pipes into the named core hook, forwarding the result.
//
// ONE dist serves BOTH Copilot surfaces (CLI 1.0.74+ and VS Code agent mode
// 1.130+): the shipped .github/hooks/aidlc.json registers PascalCase event
// names, which makes BOTH surfaces deliver Claude-shaped snake_case payloads
// (live-verified on the CLI; the IDE always sends snake_case). The
// load-bearing differences from Claude Code, all live-captured
// (tmp/copilot-compat-spike/ in the framework repo):
//   1. File-tool input keys differ: Copilot sends `path` + `file_text` /
//      `old_str` / `new_str` where the core hooks read `file_path`. The shim
//      re-keys. Tool NAMES already match (Bash/Write/Edit/Read).
//   2. PreToolUse carries NO agent identity. Subagent tool calls are
//      distinguishable (their session_id is a toolu_* tool-use id, not the
//      session UUID), and SubagentStart/SubagentStop bracket each delegation,
//      so the shim keeps a per-project active-subagent ledger: exactly one
//      active subagent → its name forwards as agent_type; zero or several →
//      no identity is forwarded and the reviewer-scope hook fails open for
//      that call (the prose §12a bound still governs; documented gap).
//   3. SubagentStart arrives camelCase (agentName, sessionId — live-verified
//      quirk) while every other PascalCase-registered event arrives
//      snake_case. Field reads tolerate both casings.
//   4. The pre-tool BLOCK channel is stdout JSON, not exit-2/stderr: the core
//      guards answer exit 2 + reason on stderr, and the shim converts that
//      into {"hookSpecificOutput": {"hookEventName": "PreToolUse",
//      "permissionDecision": "deny", "permissionDecisionReason": ...}} — the
//      one deny dialect BOTH surfaces honor (live-verified on the CLI:
//      the call is refused and the reason is relayed to the model).
//   5. Stop's block contract is identical to Claude Code:
//      {"decision":"block","reason"} on stdout passes through VERBATIM
//      (stop_hook_active included; live-verified).
//   6. SessionEnd EXISTS on the CLI (reason: complete|error|abort|...) and is
//      piped through; local VS Code chat parses but never fires it — the
//      session-start reconcile (codex D-4 pattern) covers that surface via
//      the same heartbeat file.
//
// Wiring (.github/hooks/aidlc.json, emitted by harness/copilot/emit.ts) is
// matcher-FREE by design: VS Code parses but IGNORES matchers, so a matcher
// registered for the CLI would silently broaden on the IDE. Every target
// self-filters on tool_name instead.
//
// Usage: bun {{HARNESS_DIR}}/hooks/aidlc-copilot-adapter.ts <target>
// where <target> ∈ session-start | session-end | mint | pre-tool |
//                  post-tool | validate-state | subagent-start |
//                  log-subagent | stop

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import { stateFilePath } from "../tools/aidlc-lib.ts";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface CopilotHookInput {
  hook_event_name?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  agent_name?: string;
  agentName?: string;
  agent_display_name?: string;
  stop_reason?: string;
  stop_hook_active?: boolean;
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  let copilot: CopilotHookInput = {};
  if (input.length > 0) {
    try {
      copilot = JSON.parse(input) as CopilotHookInput;
    } catch {
      return 0; // malformed stdin — advisory hooks fail open
    }
  }

  const projectDirRaw = process.env.AIDLC_PROJECT_DIR ?? copilot.cwd ?? process.cwd();
  const projectDir = isAbsolute(projectDirRaw)
    ? projectDirRaw
    : resolve(process.cwd(), projectDirRaw);
  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };

  // Tolerant field reads: PascalCase-registered events arrive snake_case on
  // both surfaces EXCEPT SubagentStart, which the CLI delivers camelCase
  // (live-verified quirk #3 above).
  const sessionId = copilot.session_id ?? copilot.sessionId ?? "";
  const subagentName = copilot.agent_name ?? copilot.agentName ?? "";

  const heartbeatFile = join(
    projectDir,
    "aidlc-docs",
    ".aidlc-hooks-health",
    "copilot-session.json",
  );

  // --- Core-hook subprocess plumbing -----------------------------------------

  function runCore(hookFile: string, stdin: string): { stdout: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdin, "utf-8"),
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectDir,
      env: projectEnv,
    });
    return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
  }

  // Variant capturing stderr — the guard hooks' block channel (exit 2 + the
  // reason on stderr) must survive the pipe so it can be converted to the
  // Copilot deny JSON.
  function runCoreWithStderr(
    hookFile: string,
    stdin: string,
  ): { stdout: string; stderr: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdin, "utf-8"),
      stdout: "pipe",
      stderr: "pipe",
      cwd: projectDir,
      env: projectEnv,
    });
    return {
      stdout: r.stdout?.toString() ?? "",
      stderr: r.stderr?.toString() ?? "",
      code: r.exitCode ?? 0,
    };
  }

  // The one deny dialect both surfaces honor (difference #4). stdout JSON,
  // exit 0 — live-verified: the tool call is refused, the reason relayed.
  function denyJson(reason: string): string {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason.trim() || "Blocked by an AIDLC guard hook.",
      },
    })}\n`;
  }

  // Re-key Copilot file-tool input (`path`, `file_text`/`old_str`/`new_str`)
  // to the core hooks' `file_path` contract (difference #1). Absent/foreign
  // shapes pass through unchanged.
  function filePathOf(toolInput: Record<string, unknown> | undefined): string | null {
    const p = toolInput?.path ?? toolInput?.file_path;
    if (typeof p !== "string" || p.length === 0) return null;
    return isAbsolute(p) ? p : join(projectDir, p);
  }

  // --- Active-subagent ledger (difference #2) ---------------------------------
  //
  // SubagentStart pushes, SubagentStop pops (by name; a crash-orphaned entry
  // expires after 30 minutes). PreToolUse forwards agent_type ONLY when the
  // call is subagent-originated (session_id is a toolu_* id) AND exactly one
  // subagent is active — ambiguity fails open rather than mis-attributing.
  const LEDGER = join(
    tmpdir(),
    `aidlc-copilot-subagents-${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}.json`,
  );

  function readLedger(): Array<{ name: string; ts: number }> {
    try {
      const entries = JSON.parse(readFileSync(LEDGER, "utf-8")) as Array<{
        name: string;
        ts: number;
      }>;
      const cutoff = Date.now() - 30 * 60 * 1000;
      return entries.filter((e) => e.ts >= cutoff);
    } catch {
      return [];
    }
  }

  function writeLedger(entries: Array<{ name: string; ts: number }>): void {
    try {
      mkdirSync(dirname(LEDGER), { recursive: true });
      writeFileSync(LEDGER, JSON.stringify(entries), "utf-8");
    } catch {
      // ledger is best-effort identity correlation — never block the turn
    }
  }

  function activeSubagentType(): string | null {
    if (!sessionId.startsWith("toolu_")) return null; // main-session call
    const entries = readLedger();
    return entries.length === 1 ? entries[0].name : null;
  }

  // --- Targets ----------------------------------------------------------------

  switch (target) {
    case "session-start": {
      reconcilePriorSession();
      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: copilot.source ?? "startup",
        ...(sessionId ? { session_id: sessionId } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd);
      // The core hook prints {"additionalContext": "..."} — Copilot consumes
      // exactly that shape from SessionStart (live-verified: injected facts
      // reached the model). No re-wrap needed.
      if (r.stdout) process.stdout.write(r.stdout);
      return 0;
    }

    case "session-end": {
      // CLI-only in practice (difference #6). Pipe the reason through and
      // clear the heartbeat so the next session-start does not double-emit.
      runCore("aidlc-session-end.ts", JSON.stringify({ reason: copilot.reason ?? "unknown" }));
      try {
        writeFileSync(heartbeatFile, JSON.stringify({ session_id: "", ts: "" }), "utf-8");
      } catch {
        // heartbeat is observability — never fail the event
      }
      return 0;
    }

    case "mint": {
      // UserPromptSubmit: record HUMAN_TURN (human-presence gate). Same
      // self-gate as the core mint hook: no workflow state, no scaffolding.
      try {
        if (existsSync(stateFilePath(projectDir))) {
          appendAuditEntry("HUMAN_TURN", {}, projectDir);
        }
      } catch {
        // best-effort presence record — advisory
      }
      return 0;
    }

    case "pre-tool": {
      // ONE registration serves both guards (matcher-free wiring): the
      // state-transition guard first, then reviewer-scope. Either block
      // converts to the deny JSON (difference #4).
      const tool = copilot.tool_name ?? "";
      if (tool === "Bash") {
        const guard = runCoreWithStderr("aidlc-state-transition-guard.ts", input);
        if (guard.code === 2) {
          process.stdout.write(denyJson(guard.stderr));
          return 0;
        }
        const scope = runCoreWithStderr("aidlc-reviewer-scope.ts", withAgentType(input));
        if (scope.code === 2) {
          process.stdout.write(denyJson(scope.stderr));
          return 0;
        }
        return 0;
      }
      if (tool === "Write" || tool === "Edit" || tool === "Read") {
        const filePath = filePathOf(copilot.tool_input);
        if (filePath) {
          const fwd = JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: tool,
            tool_input: { file_path: filePath },
            ...(activeSubagentType() ? { agent_type: activeSubagentType() } : {}),
          });
          const r = runCoreWithStderr("aidlc-reviewer-scope.ts", fwd);
          if (r.code === 2) {
            process.stdout.write(denyJson(r.stderr));
            return 0;
          }
        }
      }
      return 0;
    }

    case "post-tool": {
      // Matcher-free registration: self-filter on tool_name (the IDE ignores
      // matchers — difference in the wiring header). Advisory targets only.
      const tool = copilot.tool_name ?? "";
      if (tool === "Write" || tool === "Edit") {
        const filePath = filePathOf(copilot.tool_input);
        if (filePath) {
          const fwd = JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: tool,
            tool_input: { file_path: filePath },
          });
          runCore("aidlc-audit-logger.ts", fwd);
          runCore("aidlc-sensor-fire.ts", fwd);
        }
        return 0;
      }
      if (tool === "Bash") {
        // Copilot already names the shell tool "Bash" with tool_input.command
        // — the core hook's exact contract. Verbatim pipe.
        runCore("aidlc-runtime-compile.ts", input);
      }
      return 0;
    }

    case "validate-state": {
      // PreCompact: the core hook reads no stdin fields — self-contained.
      runCore("aidlc-validate-state.ts", input);
      return 0;
    }

    case "subagent-start": {
      if (subagentName) {
        const entries = readLedger();
        entries.push({ name: subagentName, ts: Date.now() });
        writeLedger(entries);
      }
      return 0;
    }

    case "log-subagent": {
      // SubagentStop carries agent_name (+ display name); the core hook reads
      // agent_type/agent_id. Pop the ledger entry, then forward.
      if (subagentName) {
        const entries = readLedger();
        const idx = entries.map((e) => e.name).lastIndexOf(subagentName);
        if (idx >= 0) entries.splice(idx, 1);
        writeLedger(entries);
      }
      runCore(
        "aidlc-log-subagent.ts",
        JSON.stringify({
          hook_event_name: "SubagentStop",
          agent_type: subagentName || "unknown",
          agent_id: sessionId,
        }),
      );
      return 0;
    }

    case "stop": {
      // Contract identical to Claude Code (difference #5): pass stdin
      // verbatim, forward {"decision":"block","reason"} stdout unchanged.
      const r = runCore("aidlc-stop.ts", input);
      if (r.stdout) process.stdout.write(r.stdout);
      return r.code;
    }

    default:
      return 0;
  }

  // Inject the correlated agent identity into a verbatim payload when the
  // ledger resolves one (Bash path — the file-tool path builds its own fwd).
  function withAgentType(raw: string): string {
    const agentType = activeSubagentType();
    if (!agentType) return raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed.agent_type = agentType;
      return JSON.stringify(parsed);
    } catch {
      return raw;
    }
  }

  // --- SESSION_ENDED reconcile-at-next-start (codex D-4 pattern) --------------
  // Local VS Code chat never fires SessionEnd (difference #6), and a crashed
  // CLI session cannot. The heartbeat file names the last live session; a
  // session-start that finds a DIFFERENT prior session emits the inferred
  // SESSION_ENDED through the byte-shared core hook.
  function reconcilePriorSession(): void {
    if (!existsSync(join(projectDir, "aidlc-docs"))) return;
    try {
      if (existsSync(heartbeatFile)) {
        const prior = JSON.parse(readFileSync(heartbeatFile, "utf-8")) as {
          session_id?: string;
          ts?: string;
        };
        if (prior.session_id && prior.session_id !== sessionId) {
          const reason =
            `inferred — the prior Copilot session emitted no SessionEnd (VS Code ` +
            `chat never fires it; a crashed CLI cannot); reconciled at next ` +
            `SessionStart. Prior session ${prior.session_id} last seen ${prior.ts ?? "unknown"}.`;
          runCore("aidlc-session-end.ts", JSON.stringify({ reason }));
        }
      }
      mkdirSync(dirname(heartbeatFile), { recursive: true });
      writeFileSync(
        heartbeatFile,
        JSON.stringify({ session_id: sessionId || "unknown", ts: new Date().toISOString() }),
        "utf-8",
      );
    } catch {
      // reconcile is observability — never block the session start
    }
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
}
