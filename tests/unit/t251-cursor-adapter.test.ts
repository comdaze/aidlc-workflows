// t251-cursor-adapter: pipe live-captured Cursor hook payloads through the
// authored adapter (run() export) against a seeded project and assert the
// Claude-shaped conversions on the wire.
//
// covers: hook:aidlc-mint-presence, hook:aidlc-log-subagent
//
// The fixture corpus (tests/fixtures/cursor-hook-payloads/payloads.json) is
// field-verbatim off cursor-agent 2026.07.23 on Linux (spike 2026-07-26):
// camelCase event names, tool_name "Shell" for the shell tool, Task spawns
// carrying tool_input.subagent_type, and subagent-side calls arriving under a
// DIFFERENT conversation_id with no identity fields. The adapter's contracts
// under test:
//   - sessionStart: core additionalContext re-keys to Cursor's
//     additional_context (the live-verified injection channel).
//   - guards (preToolUse): Shell maps to Bash for the core guards; a core
//     exit-2 block converts to {"permission":"deny","agent_message"} stdout
//     JSON (exit 0) - Cursor's deny channel, NOT the Claude exit-2 contract.
//   - Task spawn/completion maintains the subagent-identity ledger, so a
//     guard event from another conversation_id gets agent_type attributed
//     (the reviewer-scope bound's identity source on this harness).
//   - postToolUse Write feeds audit (ARTIFACT_*), Task feeds
//     SUBAGENT_COMPLETED, beforeSubmitPrompt mints HUMAN_TURN.
//   - stop: a core {"decision":"block","reason"} converts to
//     {"followup_message"} (advisory nudge - Cursor stop cannot block).
//   - malformed stdin fails open (exit 0, no output).

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  birthIntent,
  readAllAuditShards,
  setActiveIntentCursor,
} from "../../dist/cursor/.cursor/tools/aidlc-lib.ts";
import {
  createTestProject,
  seedAuditFile,
  seededAuditShard,
  seededRecordDir,
  seedStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CURSOR_DIST = join(REPO_ROOT, "dist", "cursor", ".cursor");
const PAYLOADS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "cursor-hook-payloads", "payloads.json"), "utf-8"),
) as Record<string, Record<string, unknown>>;

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(ledgerFileFor(dir), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A workspace-shell project with the shipped .cursor engine installed. */
function installedProject(): string {
  const root = createTestProject();
  scratch.push(root);
  cpSync(CURSOR_DIST, join(root, ".cursor"), { recursive: true });
  return root;
}

/** The adapter's tmpdir subagent ledger for a project (must mirror the
 *  adapter's own derivation). */
function ledgerFileFor(projectDir: string): string {
  return join(
    tmpdir(),
    `aidlc-cursor-subagent-${createHash("sha256").update(projectDir).digest("hex").slice(0, 16)}.json`,
  );
}

function payload(name: string, projectDir: string, extra: Record<string, unknown> = {}): string {
  const raw = JSON.stringify(PAYLOADS[name]);
  return JSON.stringify({
    ...(JSON.parse(
      raw.replaceAll("{{PROJECT}}", projectDir).replaceAll("{{TRANSCRIPT}}", `${projectDir}/t.jsonl`),
    ) as Record<string, unknown>),
    ...extra,
  });
}

function runAdapter(
  projectDir: string,
  target: string,
  stdin: string,
): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(
    "bun",
    [join(projectDir, ".cursor", "hooks", "aidlc-cursor-adapter.ts"), target],
    {
      cwd: projectDir,
      input: stdin,
      encoding: "utf-8",
      env: { ...process.env, AIDLC_PROJECT_DIR: projectDir, AIDLC_HARNESS_DIR: ".cursor" },
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 0 };
}

describe("t251 cursor adapter payload conversion", () => {
  test("1: sessionStart re-keys core additionalContext to Cursor's additional_context", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const r = runAdapter(proj, "session-start", payload("sessionStart", proj));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(typeof out.additional_context).toBe("string");
    expect(out.additional_context as string).toContain("AIDLC WORKFLOW ACTIVE");
    expect(out).not.toHaveProperty("additionalContext");
    // The session start landed in the audit trail through the core hook.
    const shard = readAllAuditShards(proj);
    expect(shard).toContain("SESSION_STARTED");
  });

  test("2: sessionStart without workflow state stays silent (no scaffolding)", () => {
    const proj = installedProject();
    const r = runAdapter(proj, "session-start", payload("sessionStart", proj));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("3: guards convert a state-guard block to Cursor's permission-deny JSON", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    // A direct lifecycle mutation through aidlc-state.ts is the state guard's
    // canonical refusal; on Cursor it must arrive as deny JSON, exit 0.
    const stdin = payload("preToolUseShell", proj, {
      tool_input: { command: "bun .cursor/tools/aidlc-state.ts approve", cwd: "", timeout: 30000 },
    });
    const r = runAdapter(proj, "guards", stdin);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { permission?: string; agent_message?: string };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("aidlc-orchestrate");
  });

  test("4: guards allow an ordinary shell command silently", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const r = runAdapter(proj, "guards", payload("preToolUseShell", proj));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("5: Task spawn feeds the identity ledger; a foreign-conversation call is attributed and scope-enforced", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const record = seededRecordDir(proj);
    rmSync(ledgerFileFor(proj), { force: true });
    // 12a step-1: the conductor's dispatch record scopes the reviewer to
    // unit-a; unit-b is a sibling.
    mkdirSync(join(record, "construction", "unit-b"), { recursive: true });
    writeFileSync(
      join(record, ".aidlc-reviewer-dispatch.json"),
      JSON.stringify({
        reviewer: "aidlc-architecture-reviewer-agent",
        stage: "functional-design",
        unit: "unit-a",
        exempt: [],
      }),
    );
    // Spawn: the MAIN conversation's Task call records the ledger entry.
    const spawn = runAdapter(proj, "guards", payload("preToolUseTask", proj));
    expect(spawn.code).toBe(0);
    expect(existsSync(ledgerFileFor(proj))).toBe(true);
    // The reviewer's own Read (different conversation_id, no identity in the
    // payload) targets a SIBLING unit -> deny JSON with the scope reason.
    const sibling = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    expect(sibling.code).toBe(0);
    const out = JSON.parse(sibling.stdout) as { permission?: string; agent_message?: string };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("unit-a");
    // Completion clears the ledger...
    const done = runAdapter(proj, "audit-and-sensors", payload("postToolUseTask", proj));
    expect(done.code).toBe(0);
    expect(existsSync(ledgerFileFor(proj))).toBe(false);
    // ...and the same sibling read now passes through (no identity -> not the
    // dispatched reviewer -> core hook allows).
    const after = runAdapter(
      proj,
      "guards",
      payload("preToolUseSubagentRead", proj, {
        tool_input: { file_path: join(record, "construction", "unit-b", "design.md") },
      }),
    );
    expect(after.code).toBe(0);
    expect(after.stdout.trim()).toBe("");
  });

  test("6: postToolUse Write lands an audit row; Task lands SUBAGENT_COMPLETED; mint lands HUMAN_TURN", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    // The audit-logger never auto-creates the trail (orchestrator-owned) -
    // seed the shard the way a running workflow would have.
    seedAuditFile(proj);
    const artifact = join(seededRecordDir(proj), "construction", "functional-design", "design.md");
    mkdirSync(join(seededRecordDir(proj), "construction", "functional-design"), {
      recursive: true,
    });
    writeFileSync(artifact, "# design\n");
    const w = runAdapter(
      proj,
      "audit-and-sensors",
      payload("postToolUseWrite", proj, { tool_input: { file_path: artifact, content: "# design\n" } }),
    );
    expect(w.code).toBe(0);
    const t = runAdapter(proj, "audit-and-sensors", payload("postToolUseTask", proj));
    expect(t.code).toBe(0);
    const m = runAdapter(proj, "mint", payload("sessionStart", proj));
    expect(m.code).toBe(0);
    const shard = readFileSync(seededAuditShard(proj), "utf-8");
    expect(shard).toContain("ARTIFACT_");
    expect(shard).toContain("SUBAGENT_COMPLETED");
    expect(shard).toContain("aidlc-architecture-reviewer-agent");
    expect(shard).toContain("HUMAN_TURN");
  });

  test("7: a delegated conversation cannot spawn a nested Task or overwrite the parent ledger", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const ledger = ledgerFileFor(proj);
    rmSync(ledger, { force: true });

    const parent = runAdapter(proj, "guards", payload("preToolUseTask", proj));
    expect(parent.code).toBe(0);
    const before = readFileSync(ledger, "utf-8");

    const nested = runAdapter(
      proj,
      "guards",
      payload("preToolUseTask", proj, {
        conversation_id: "ece1fcdd-ebab-4b21-b074-95e19faafc3a",
        session_id: "ece1fcdd-ebab-4b21-b074-95e19faafc3a",
        tool_input: {
          description: "Nested probe",
          prompt: "Try to delegate again.",
          subagent_type: "aidlc-developer-agent",
        },
      }),
    );
    expect(nested.code).toBe(0);
    const out = JSON.parse(nested.stdout) as { permission?: string; agent_message?: string };
    expect(out.permission).toBe("deny");
    expect(out.agent_message ?? "").toContain("nested delegation is not allowed");
    expect(readFileSync(ledger, "utf-8")).toBe(before);
  });

  test("8: beforeSubmitPrompt surfaces a one-time rebind offer after intent drift", () => {
    const proj = installedProject();
    const a = birthIntent(proj, "intent-a", "default", "feature");
    const b = birthIntent(proj, "intent-b", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");

    const started = runAdapter(proj, "session-start", payload("sessionStart", proj));
    expect(started.code).toBe(0);
    setActiveIntentCursor(proj, b.dirName, "default");

    const warned = runAdapter(proj, "mint", payload("beforeSubmitPrompt", proj));
    expect(warned.code).toBe(0);
    const out = JSON.parse(warned.stdout) as { continue?: boolean; user_message?: string };
    expect(out.continue).toBe(false);
    expect(out.user_message ?? "").toContain("INTENT REBIND OFFER");
    expect(out.user_message ?? "").toContain("intent-a");
    expect(out.user_message ?? "").toContain("intent-b");
    expect(out.user_message ?? "").toContain("/aidlc intent intent-a");

    // The blocked warning is consumed: resubmitting continues on B instead of
    // deadlocking on the same beforeSubmitPrompt response.
    const next = runAdapter(proj, "mint", payload("beforeSubmitPrompt", proj));
    expect(next.code).toBe(0);
    expect(next.stdout.trim()).toBe("");
    const shard = readAllAuditShards(proj);
    expect(shard).toContain("HUMAN_TURN");
    expect(shard).not.toContain("SESSION_RESUMED");
  });

  test("9: beforeSubmitPrompt is silent when the session's intent is unchanged", () => {
    const proj = installedProject();
    const a = birthIntent(proj, "unchanged", "default", "feature");
    setActiveIntentCursor(proj, a.dirName, "default");
    runAdapter(proj, "session-start", payload("sessionStart", proj));

    const r = runAdapter(proj, "mint", payload("beforeSubmitPrompt", proj));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(readAllAuditShards(proj)).toContain("HUMAN_TURN");
  });

  test("10: sessionEnd forwards the reason into SESSION_ENDED", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    const r = runAdapter(proj, "session-end", payload("sessionEnd", proj));
    expect(r.code).toBe(0);
    const shard = readFileSync(seededAuditShard(proj), "utf-8");
    expect(shard).toContain("SESSION_ENDED");
    expect(shard).toContain("completed");
  });

  test("11: stop converts a core block into an advisory followup_message", () => {
    const proj = installedProject();
    seedStateFile(proj, "state-construction.md");
    // An in-flight stage (state seeded mid-construction with no completed
    // report) makes the core stop hook emit its pending-directive block.
    const r = runAdapter(proj, "stop", payload("stop", proj));
    expect(r.code).toBe(0);
    if (r.stdout.trim().length > 0) {
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      // Whatever the core decided, the Cursor wire never carries the Claude
      // block contract - only the advisory follow-up channel.
      expect(out).not.toHaveProperty("decision");
      expect(typeof out.followup_message).toBe("string");
      expect((out.followup_message as string).length).toBeGreaterThan(0);
    }
  });

  test("12: malformed stdin fails open on every target", () => {
    const proj = installedProject();
    for (const target of [
      "session-start",
      "session-end",
      "mint",
      "guards",
      "audit-and-sensors",
      "runtime-compile",
      "validate-state",
      "stop",
    ]) {
      const r = runAdapter(proj, target, "{not json");
      expect(r.code, `${target}: fails open`).toBe(0);
    }
  });

  test("13: unknown target is a silent no-op (wiring typo cannot break a turn)", () => {
    const proj = installedProject();
    const r = runAdapter(proj, "no-such-target", payload("sessionStart", proj));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
