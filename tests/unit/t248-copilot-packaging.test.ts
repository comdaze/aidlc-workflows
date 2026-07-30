// t248-copilot-packaging: dist/copilot parity + drift guard + shell shape.
//
// covers: file:tools/aidlc-lib.ts
//
// WHAT. Four contracts land here:
//   (1) The committed dist/copilot tree is byte-identical to what
//       `bun scripts/package.ts copilot --check` regenerates (drift guard,
//       same UX as codex's t150 test 1 / opencode's t240 test 1).
//   (2) Core parity: every .ts under dist/copilot/.aidlc/{tools,hooks}/
//       except the authored adapter is BYTE-IDENTICAL to its dist/claude
//       source (the architecture-B invariant: the packager may transform
//       prose/data paths, never code).
//   (3) The .github/ shell carries ONLY aidlc-named emissions — .github/ is
//       SHARED with real repo content in a user install, so every emitted
//       file must be collision-free (aidlc-prefixed dirs/files), and the
//       hook wiring must register PascalCase events with matcher-FREE
//       entries (VS Code parses but IGNORES matchers — a matcher would
//       silently broaden there; the adapter self-filters instead).
//   (4) The emitted persona twins carry NO model:/tier: keys (the two
//       Copilot surfaces disagree on model-value syntax — live-verified 400
//       on the CLI with an IDE display name — so agents must inherit the
//       session model) and project the core Task denial to a supported tools
//       allowlist that excludes Copilot's `agent` delegation tool.
//
// WHY SUBPROCESS for (1). Same idiom as t141/t150/t240: the packager is a
// CLI; we pin its observable behavior, not its internals.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const COPILOT_ROOT = join(REPO_ROOT, "dist", "copilot");
const ENGINE = join(COPILOT_ROOT, ".aidlc");
const SHELL = join(COPILOT_ROOT, ".github");
const WORKER_TOOLS_LINE = 'tools: ["read", "edit", "search", "execute", "web", "todo"]';

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t248 dist/copilot packaging parity + shell shape", () => {
  test("1: committed dist/copilot matches the packaging script (drift guard)", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "copilot", "--check"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      timeout: 180_000,
    });
    expect(r.stdout + r.stderr).toContain("--check: OK");
    expect(r.status).toBe(0);
  });

  test("2: engine .ts files are byte-identical to the dist/claude sources", () => {
    expect(existsSync(ENGINE)).toBe(true);
    let compared = 0;
    for (const sub of ["tools", "hooks"]) {
      for (const file of walk(join(ENGINE, sub))) {
        if (!file.endsWith(".ts")) continue;
        const rel = relative(ENGINE, file);
        // The authored shim is copilot-only; everything else is shared core.
        if (rel === join("hooks", "aidlc-copilot-adapter.ts")) continue;
        // Compiled data (tools/data/) is per-tree by design; only code is pinned.
        if (rel.split(sep).includes("data")) continue;
        const claudeTwin = join(CLAUDE_SRC, rel);
        expect(existsSync(claudeTwin)).toBe(true);
        expect(readFileSync(file, "utf-8")).toBe(readFileSync(claudeTwin, "utf-8"));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });

  test("3: .github shell is aidlc-prefixed only, hooks PascalCase + matcher-free", () => {
    // Every emitted path is collision-free for a merge into a user's .github/.
    for (const file of walk(SHELL)) {
      const rel = relative(SHELL, file);
      const top = rel.split(sep)[0];
      expect(["hooks", "agents", "skills"]).toContain(top);
      const name = rel.split(sep)[1] ?? "";
      expect(name.startsWith("aidlc")).toBe(true);
    }
    const wiring = JSON.parse(readFileSync(join(SHELL, "hooks", "aidlc.json"), "utf-8")) as {
      version: number;
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    expect(wiring.version).toBe(1);
    const events = Object.keys(wiring.hooks);
    // PascalCase registration is the shared-payload recipe: both surfaces
    // then deliver snake_case payloads to the one adapter.
    for (const event of events) {
      expect(event[0]).toBe(event[0].toUpperCase());
      for (const entry of wiring.hooks[event]) {
        expect(entry.matcher).toBeUndefined();
        expect(String(entry.bash)).toContain("aidlc-copilot-adapter.ts");
      }
    }
    for (const required of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "SessionEnd"]) {
      expect(events).toContain(required);
    }
  });

  test("4: persona twins carry no model/tier keys and exclude the agent delegation tool", () => {
    const agentsDir = join(SHELL, "agents");
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(14);
    for (const f of files) {
      const raw = readFileSync(join(agentsDir, f), "utf-8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? "";
      expect(fm).not.toMatch(/^model:/m);
      expect(fm).not.toMatch(/^tier:/m);
      expect(fm).not.toMatch(/^disallowedTools:/m);
      expect(fm).not.toMatch(/^agents:/m);
      // The core source declares the Task denial on every current persona;
      // its projected form is Copilot's supported built-in tool allowlist.
      const coreSrc = readFileSync(join(REPO_ROOT, "core", "agents", f), "utf-8");
      if (/^disallowedTools:/m.test(coreSrc)) {
        expect(fm.split("\n")).toContain(WORKER_TOOLS_LINE);
      }
      // Body prose points at the engine dir, never an unsubstituted token.
      expect(raw).not.toContain("{{HARNESS_DIR}}");
    }
  });

  test("5: skills tree carries the orchestrator + generated runners", () => {
    const skills = readdirSync(join(SHELL, "skills"));
    expect(skills).toContain("aidlc");
    expect(skills).toContain("aidlc-init");
    expect(skills).toContain("aidlc-compose");
    expect(skills.length).toBeGreaterThan(30);
    const orchestrator = readFileSync(join(SHELL, "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(orchestrator).toContain("Copilot harness");
    expect(orchestrator).toContain("bun .aidlc/tools/aidlc-orchestrate.ts next");
    expect(orchestrator).not.toContain("{{HARNESS_DIR}}");
    const harnessData = JSON.parse(
      readFileSync(join(ENGINE, "tools", "data", "harness.json"), "utf-8"),
    ) as { name?: string };
    expect(harnessData.name).toBe("copilot");
  });

  test("6: doctor catches missing Copilot hook dependencies and root AGENTS.md", () => {
    const project = mkdtempSync(join(tmpdir(), "t248-copilot-doctor-"));
    try {
      cpSync(COPILOT_ROOT, project, { recursive: true });
      rmSync(join(project, ".aidlc", "hooks", "aidlc-state-transition-guard.ts"));
      rmSync(join(project, "AGENTS.md"));
      const result = spawnSync(
        process.execPath,
        [
          join(project, ".aidlc", "tools", "aidlc-utility.ts"),
          "doctor",
          "--project-dir",
          project,
        ],
        {
          cwd: project,
          encoding: "utf-8",
          env: {
            ...process.env,
            AIDLC_HARNESS_DIR: ".aidlc",
            AIDLC_HARNESS_NAME: "copilot",
            COPILOT_HOME: join(project, ".copilot-home"),
          },
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(output).toContain("✗  aidlc-state-transition-guard.ts present");
      expect(output).toContain("✗  AGENTS.md present (onboarding + method imports)");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
