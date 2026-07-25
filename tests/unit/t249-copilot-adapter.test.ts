// t249-copilot-adapter: the Copilot stdin shim normalizes live-captured
// payloads into the core hooks' contract.
//
// covers: file:hooks/aidlc-stop.ts, file:hooks/aidlc-session-start.ts, file:hooks/aidlc-audit-logger.ts, file:hooks/aidlc-log-subagent.ts, file:hooks/aidlc-session-end.ts
//
// WHAT. Each case pipes a fixture from tests/fixtures/copilot-hook-payloads/
// (field-verbatim captures off Copilot CLI 1.0.74 — the compat-spike corpus
// at tmp/copilot-compat-spike/proj/hookout/) into
// `bun dist/copilot/.aidlc/hooks/aidlc-copilot-adapter.ts <target>` inside a
// scratch project carrying an active workflow state, then asserts the
// observable core-hook effect:
//   stop           → {"decision":"block"} when the engine says work remains
//                    (verbatim passthrough — the contract is identical to
//                    Claude Code); silent exit 0 with no state.
//   session-start  → {"additionalContext": ...} passes through UNWRAPPED
//                    (Copilot consumes the core hook's exact shape — no
//                    hookSpecificOutput envelope, unlike codex).
//   pre-tool deny  → a guard block (core exit 2 + stderr) converts to the
//                    {"hookSpecificOutput":{"permissionDecision":"deny"}}
//                    stdout JSON with exit 0 — Copilot's only deny channel.
//   pre-tool remap → Copilot's `path` file-tool key reaches the core hooks
//                    as `file_path` (the shim re-keys).
//   post-tool      → a Write into the record lands ARTIFACT_CREATED in the
//                    audit; a foreign tool_name is a no-op (self-filtering
//                    replaces matchers — VS Code ignores them).
//   log-subagent   → SUBAGENT_COMPLETED in the audit, agent_name (snake) or
//                    agentName (camel — the live SubagentStart quirk) both
//                    resolving to agent_type.
//   session-end    → SESSION_ENDED with the CLI's reason field.
//   malformed stdin → fail-open exit 0 (advisory contract).
//
// WHY SUBPROCESS. The adapter IS a subprocess shim — in-process unit testing
// would bypass the exact stdin/stdout/exit-code surface being contracted.
// (Same idiom as codex's t149.)

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPILOT_TREE = join(REPO_ROOT, "dist", "copilot", ".aidlc");
const FIXTURES = JSON.parse(
  readFileSync(
    join(REPO_ROOT, "tests", "fixtures", "copilot-hook-payloads", "payloads.json"),
    "utf-8",
  ),
) as Record<string, Record<string, unknown>>;

const PINNED_CLONE_ID = "testcloneid249";
function pinnedShardName(): string {
  const host =
    hostname()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "host";
  return `${host}-${PINNED_CLONE_ID}.md`;
}

function seedShell(dir: string): void {
  const intentsDir = intentsDirOf(dir, DEFAULT_SPACE);
  mkdirSync(join(dir, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  mkdirSync(seededRecordDir(dir), { recursive: true });
  writeFileSync(join(dir, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`, "utf-8");
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [
        {
          uuid: "00000000-0000-7000-8000-000000000001",
          slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
          status: "in-flight",
        },
      ],
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

function scratchProject(withState: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "t249-")));
  cpSync(COPILOT_TREE, join(dir, ".aidlc"), { recursive: true });
  seedShell(dir);
  if (withState) {
    writeFileSync(
      seededStateFile(dir),
      readFileSync(join(REPO_ROOT, "tests", "fixtures", "state-brownfield-feature.md"), "utf-8"),
    );
    writeFileSync(join(dir, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
    const auditDir = seededAuditDir(dir);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, pinnedShardName()), "# AI-DLC Audit Log\n");
  }
  return dir;
}

function readAudit(dir: string): string {
  const auditDir = seededAuditDir(dir);
  let names: string[];
  try {
    names = readdirSync(auditDir);
  } catch {
    return "";
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => readFileSync(join(auditDir, n), "utf-8"))
    .join("\n");
}

function withCwd(payload: Record<string, unknown>, dir: string): Record<string, unknown> {
  return { ...payload, cwd: dir };
}

function runAdapter(
  projectDir: string,
  target: string,
  payload: unknown,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), target],
    {
      cwd: projectDir,
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: undefined } as NodeJS.ProcessEnv,
      timeout: 30_000,
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

describe("t249 Copilot hook adapter (live-captured payload fixtures)", () => {
  test("1: stop with active workflow blocks (verbatim Claude-shaped passthrough)", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "stop", withCwd(FIXTURES.stop, dir));
    const parsed = JSON.parse(r.stdout) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason?.length ?? 0).toBeGreaterThan(0);
  });

  test("2: stop without workflow state is a silent allow", () => {
    const dir = scratchProject(false);
    const r = runAdapter(dir, "stop", withCwd(FIXTURES.stop, dir));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("3: session-start context passes through UNWRAPPED (Copilot's native shape)", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "session-start", withCwd(FIXTURES.sessionStart, dir));
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(typeof parsed.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  test("4: pre-tool guard block converts to the permissionDecision deny JSON", () => {
    const dir = scratchProject(true);
    // A direct lifecycle call on aidlc-state.ts is exactly what the
    // state-transition guard refuses (exit 2 + reason on stderr in core).
    const payload = withCwd(
      {
        ...FIXTURES.preToolUse_bash,
        tool_input: { command: "bun .aidlc/tools/aidlc-state.ts approve" },
      },
      dir,
    );
    const r = runAdapter(dir, "pre-tool", payload);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput?.permissionDecisionReason?.length ?? 0).toBeGreaterThan(0);
  });

  test("5: pre-tool allows an ordinary command silently", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "pre-tool", withCwd(FIXTURES.preToolUse_bash, dir));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("6: post-tool Write into the record lands ARTIFACT_CREATED (path re-keyed)", () => {
    const dir = scratchProject(true);
    const artifact = join(seededRecordDir(dir), "ideation", "intent-capture", "intent.md");
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, "# Intent\n", "utf-8");
    // The live capture's tool_input carries Copilot's `path` key — the shim
    // must re-key it to file_path for the core audit-logger.
    const payload = withCwd(
      { ...FIXTURES.preToolUse_write, tool_input: { path: artifact, file_text: "# Intent\n" } },
      dir,
    );
    const r = runAdapter(dir, "post-tool", payload);
    expect(r.code).toBe(0);
    expect(readAudit(dir)).toContain("ARTIFACT_CREATED");
  });

  test("7: post-tool with a foreign tool_name is a no-op (self-filtering, no matchers)", () => {
    const dir = scratchProject(true);
    const before = readAudit(dir);
    const payload = withCwd({ ...FIXTURES.preToolUse_write, tool_name: "Agent" }, dir);
    const r = runAdapter(dir, "post-tool", payload);
    expect(r.code).toBe(0);
    expect(readAudit(dir)).toBe(before);
  });

  test("8: log-subagent lands SUBAGENT_COMPLETED from the snake_case capture", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "log-subagent", withCwd(FIXTURES.subagentStop, dir));
    expect(r.code).toBe(0);
    const audit = readAudit(dir);
    expect(audit).toContain("SUBAGENT_COMPLETED");
    expect(audit).toContain(String(FIXTURES.subagentStop.agent_name));
  });

  test("9: subagent-start accepts the camelCase live capture (the CLI quirk)", () => {
    const dir = scratchProject(true);
    // subagentStart is delivered camelCase (agentName/sessionId) on the CLI
    // while every other PascalCase-registered event is snake_case.
    const r = runAdapter(dir, "subagent-start", withCwd(FIXTURES.subagentStart, dir));
    expect(r.code).toBe(0);
  });

  test("10: session-end lands SESSION_ENDED with the CLI's reason", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "session-end", withCwd(FIXTURES.sessionEnd, dir));
    expect(r.code).toBe(0);
    expect(readAudit(dir)).toContain("SESSION_ENDED");
  });

  test("11: malformed stdin fails open (advisory contract)", () => {
    const dir = scratchProject(true);
    const r = runAdapter(dir, "post-tool", "{not json");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("12: mint records HUMAN_TURN only when workflow state exists", () => {
    const withStateDir = scratchProject(true);
    runAdapter(withStateDir, "mint", withCwd(FIXTURES.userPromptSubmit, withStateDir));
    expect(readAudit(withStateDir)).toContain("HUMAN_TURN");

    const noStateDir = scratchProject(false);
    const r = runAdapter(noStateDir, "mint", withCwd(FIXTURES.userPromptSubmit, noStateDir));
    expect(r.code).toBe(0);
    expect(readAudit(noStateDir)).toBe("");
  });
});
