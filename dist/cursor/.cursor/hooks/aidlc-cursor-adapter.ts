#!/usr/bin/env bun
// aidlc-cursor-adapter.ts — the Cursor hook shim (AUTHORED shell file; the
// aidlc-*.ts hook bodies beside it are PACKAGED core, byte-shared with the
// Claude Code harness). Modeled on codex's aidlc-codex-adapter.ts: ONE shim
// normalizes the Cursor payload to the ClaudeCodeHookInput shape and
// subprocess-pipes into the named core hook.
//
// Cursor payloads (live corpus, cursor-agent 2026.07.23 on Linux; the IDE
// shares the hooks.json surface) are near-isomorphic to Claude Code's with
// these load-bearing differences:
//   1. Event names are camelCase (sessionStart, preToolUse, ...) and each
//      event has its OWN stdout output schema — a PreToolUse deny is
//      {"permission":"deny","agent_message"} JSON, NOT exit 2 + stderr
//      (exit 2 does block, but the reason channel is the JSON field);
//      sessionStart context is {"additional_context"} (snake_case), and stop
//      cannot block at all — only {"followup_message"} (advisory nudge).
//   2. The shell tool is named "Shell" (tool_input.command, like Bash).
//      Read/Write/Edit/Task already match Claude's names and input shapes.
//   3. No duplicate delivery (unlike Codex) and a REAL sessionEnd event
//      (unlike Codex/Copilot) — no replay cache, no heartbeat reconcile.
//   4. subagentStart/subagentStop are documented but NEVER fire on the CLI
//      (live-verified): subagent tracking rides preToolUse/postToolUse of the
//      Task tool (tool_input.subagent_type carries the agent name), and
//      subagent-side tool calls carry NO agent identity — only a fresh
//      conversation_id. A tmpdir ledger written at Task-spawn time restores
//      the reviewer's identity for the reviewer-scope bound (single-reviewer
//      dispatch is the 12a contract, so last-spawn attribution is sound).
//
// Usage (wired in .cursor/hooks.json, cwd = project root):
//   bun .cursor/hooks/aidlc-cursor-adapter.ts <target>
// where <target> ∈ session-start | session-end | mint | guards |
//                  audit-and-sensors | runtime-compile | validate-state |
//                  stop

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

interface CursorHookInput {
  hook_event_name?: string;
  conversation_id?: string;
  session_id?: string;
  cwd?: string;
  workspace_roots?: string[];
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  reason?: string;
  source?: string;
  is_background_agent?: boolean;
}

export async function run(
  target: string,
  input: string,
  _extraArgs: string[] = [],
): Promise<number> {
  let rawInput = "";
  let cursor: CursorHookInput = {};
  if (!process.stdin.isTTY) {
    try {
      rawInput = input;
      if (rawInput.length > 0) cursor = JSON.parse(rawInput) as CursorHookInput;
    } catch {
      return 0; // malformed stdin — advisory hooks fail open
    }
  }

  const projectDirRaw =
    process.env.AIDLC_PROJECT_DIR ?? cursor.workspace_roots?.[0] ?? process.cwd();
  const projectDir = isAbsolute(projectDirRaw)
    ? projectDirRaw
    : resolve(process.cwd(), projectDirRaw);
  const projectEnv = {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };

  // --- Core-hook subprocess plumbing ------------------------------------------

  function runCore(hookFile: string, stdinText: string): { stdout: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
      stdout: "pipe",
      stderr: "ignore",
      cwd: projectDir,
      env: projectEnv,
    });
    return { stdout: r.stdout?.toString() ?? "", code: r.exitCode ?? 0 };
  }

  function runCoreWithStderr(
    hookFile: string,
    stdinText: string,
  ): { stdout: string; stderr: string; code: number } {
    const executable = process.env.AIDLC_COMPILED_EXECUTABLE;
    const command = executable
      ? [executable, "hook", hookFile.replace(/^aidlc-|\.ts$/g, "")]
      : [process.execPath, join(HOOKS_DIR, hookFile)];
    const r = Bun.spawnSync(command, {
      stdin: Buffer.from(stdinText, "utf-8"),
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

  // --- Subagent-identity ledger -------------------------------------------------
  //
  // Cursor delivers NO agent identity on a subagent's own tool calls, and the
  // subagentStart/Stop events never fire on the CLI. The Task-tool calls in the
  // MAIN conversation do carry tool_input.subagent_type, so the guards target
  // records the spawn (name + the parent's conversation_id) here at preToolUse
  // time; a later guard event whose conversation_id differs from the recorded
  // parent while the ledger is fresh is attributed to that subagent. The 12a
  // reviewer contract dispatches ONE reviewer at a time, so last-spawn
  // attribution is sound for the reviewer-scope bound; ambiguity from parallel
  // spawns only widens enforcement to more calls, never blocks the conductor
  // (identity must MATCH dispatch.reviewer for the core hook to enforce).
  const LEDGER_TTL_MS = 30 * 60 * 1000;
  const ledgerFile = join(
    tmpdir(),
    `aidlc-cursor-subagent-${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}.json`,
  );

  function recordSpawn(subagentType: string): void {
    try {
      writeFileSync(
        ledgerFile,
        JSON.stringify({ agent: subagentType, parent: cursor.conversation_id ?? "" }),
        "utf-8",
      );
    } catch {
      // best-effort — enforcement degrades to main-session-only
    }
  }

  function clearSpawn(): void {
    try {
      rmSync(ledgerFile, { force: true });
    } catch {
      // stale ledger expires via TTL
    }
  }

  function activeSubagent(): string {
    try {
      if (!existsSync(ledgerFile)) return "";
      if (Date.now() - statSync(ledgerFile).mtimeMs > LEDGER_TTL_MS) return "";
      const led = JSON.parse(readFileSync(ledgerFile, "utf-8")) as {
        agent?: string;
        parent?: string;
      };
      if (!led.agent) return "";
      // A guard event from a conversation OTHER than the spawning parent's is
      // the subagent's own call.
      if (led.parent && cursor.conversation_id && cursor.conversation_id !== led.parent) {
        return led.agent;
      }
      return "";
    } catch {
      return "";
    }
  }

  // Cursor's shell tool is "Shell"; the core hooks key on Claude's "Bash".
  // Everything else (Read/Write/Edit/Grep/Glob/Task/...) already matches.
  const toolName = cursor.tool_name === "Shell" ? "Bash" : (cursor.tool_name ?? "");

  function claudeShaped(eventName: string): string {
    return JSON.stringify({
      ...cursor,
      hook_event_name: eventName,
      tool_name: toolName,
      ...(activeSubagent() ? { agent_type: activeSubagent() } : {}),
    });
  }

  // --- Targets ------------------------------------------------------------------

  switch (target) {
    case "session-start": {
      const fwd = JSON.stringify({
        hook_event_name: "SessionStart",
        source: cursor.source ?? "startup",
        ...(cursor.session_id ? { session_id: cursor.session_id } : {}),
      });
      const r = runCore("aidlc-session-start.ts", fwd);
      // Core prints {"additionalContext"} (Claude's key); Cursor consumes
      // {"additional_context"} (live-verified injection channel).
      try {
        const parsed = JSON.parse(r.stdout) as { additionalContext?: string };
        if (parsed.additionalContext) {
          process.stdout.write(`${JSON.stringify({ additional_context: parsed.additionalContext })}\n`);
        }
      } catch {
        // no context payload — silent
      }
      return 0;
    }

    case "session-end": {
      const fwd = JSON.stringify({
        hook_event_name: "SessionEnd",
        reason: cursor.reason ?? "other",
        ...(cursor.session_id ? { session_id: cursor.session_id } : {}),
      });
      runCore("aidlc-session-end.ts", fwd);
      return 0;
    }

    case "mint": {
      // beforeSubmitPrompt: a real human acted this turn. Advisory.
      runCore("aidlc-mint-presence.ts", JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
      return 0;
    }

    case "guards": {
      // preToolUse: the state-transition guard, then the reviewer read-scope
      // bound (the Claude settings.json registration order). Both core hooks
      // self-filter by tool; a Task spawn additionally feeds the identity
      // ledger. Block contract conversion: core exit 2 + stderr becomes
      // Cursor's {"permission":"deny","agent_message"} stdout JSON
      // (live-verified: the deny blocks the call and relays the reason).
      if (toolName === "Task") {
        const sub = cursor.tool_input?.subagent_type;
        if (typeof sub === "string" && sub.length > 0) recordSpawn(sub);
        return 0;
      }
      const fwd = claudeShaped("PreToolUse");
      for (const guard of ["aidlc-state-transition-guard.ts", "aidlc-reviewer-scope.ts"]) {
        const r = runCoreWithStderr(guard, fwd);
        if (r.code === 2) {
          const reason = r.stderr.trim() || "blocked by AIDLC guard hook";
          process.stdout.write(`${JSON.stringify({ permission: "deny", agent_message: reason })}\n`);
          return 0;
        }
      }
      return 0;
    }

    case "audit-and-sensors": {
      // postToolUse Write|Edit → audit THEN sensors (Claude registration
      // order); postToolUse Task → subagent completion (log + ledger clear).
      if (toolName === "Write" || toolName === "Edit") {
        const fwd = claudeShaped("PostToolUse");
        runCore("aidlc-audit-logger.ts", fwd);
        runCore("aidlc-sensor-fire.ts", fwd);
      } else if (toolName === "Task") {
        const sub = cursor.tool_input?.subagent_type;
        const fwd = JSON.stringify({
          hook_event_name: "SubagentStop",
          ...(typeof sub === "string" && sub.length > 0 ? { agent_type: sub } : {}),
        });
        runCore("aidlc-log-subagent.ts", fwd);
        clearSpawn();
      }
      return 0;
    }

    case "runtime-compile": {
      // postToolUse Shell → the runtime-graph compile watcher (keys on Bash +
      // tool_input.command — the mapped payload is its exact contract).
      if (toolName === "Bash") runCore("aidlc-runtime-compile.ts", claudeShaped("PostToolUse"));
      return 0;
    }

    case "validate-state": {
      // preCompact: the core hook reads no stdin fields — self-contained.
      runCore("aidlc-validate-state.ts", rawInput);
      return 0;
    }

    case "stop": {
      // Cursor's stop hook CANNOT block (no decision channel). The core stop
      // hook's {"decision":"block","reason"} converts to a followup_message —
      // the forwarding-loop nudge is ADVISORY on this harness (the opencode
      // session.idle precedent), re-engaging the loop by injecting the reason
      // as a follow-up prompt instead of refusing the stop.
      const r = runCore("aidlc-stop.ts", rawInput);
      try {
        const parsed = JSON.parse(r.stdout) as { decision?: string; reason?: string };
        if (parsed.decision === "block" && parsed.reason) {
          process.stdout.write(`${JSON.stringify({ followup_message: parsed.reason })}\n`);
        }
      } catch {
        // advisory — no output
      }
      return 0;
    }

    default:
      return 0;
  }
}

if (import.meta.main) {
  process.exit(await run(process.argv[2] ?? "", await Bun.stdin.text(), process.argv.slice(3)));
}
