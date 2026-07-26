// t250-cursor-packaging: dist/cursor parity + drift guard + shell shape.
//
// covers: file:tools/aidlc-lib.ts
//
// WHAT. Five contracts land here:
//   (1) The committed dist/cursor tree is byte-identical to what
//       `bun scripts/package.ts cursor --check` verifies (drift guard, same
//       UX as opencode's t240 test 1).
//   (2) Core parity: every .ts under dist/cursor/.cursor/{tools,hooks}/ is
//       BYTE-IDENTICAL to its dist/claude source (the architecture-B
//       invariant: the packager may transform prose/data paths, never code)
//       - all but the authored adapter, which has no Claude twin.
//   (3) The Cursor-native surfaces are shaped for Cursor's scanners: the
//       rules dir carries ONLY .mdc (a plain .md in .cursor/rules/ is
//       silently ignored by Cursor - live-verified), the method rule is
//       alwaysApply, and hooks.json wires only camelCase events through the
//       adapter.
//   (4) The persona files double as live native subagents on Cursor, so no
//       agent may carry a model pin (model availability is plan-dependent;
//       a pinned id hard-fails Free/lower plans) and the raw tier: key never
//       leaks.
//   (5) The doctor recognizes a dist/cursor install (adapter + wiring
//       checks pass on the pristine tree).
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
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "package.ts");
const CLAUDE_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const CURSOR_ROOT = join(REPO_ROOT, "dist", "cursor");
const ENGINE = join(CURSOR_ROOT, ".cursor");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

describe("t250 dist/cursor packaging parity + shell shape", () => {
  test("1: committed dist/cursor matches the packaging script (drift guard)", () => {
    const r = spawnSync("bun", [PACKAGE_SCRIPT, "cursor", "--check"], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
    });
    if (r.status !== 0) {
      // Surface the script's own stale-file list - it names the fix.
      console.error(r.stderr);
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("in sync");
  });

  test("2: every packaged .ts file is byte-identical to its dist/claude source (code is never transformed)", () => {
    const divergent: string[] = [];
    for (const sub of ["tools", "hooks"]) {
      const dstDir = join(ENGINE, sub);
      for (const file of walk(dstDir)) {
        if (!file.endsWith(".ts")) continue;
        const rel = file.slice(dstDir.length + 1);
        // The adapter is AUTHORED for this harness - no Claude twin exists.
        if (rel === "aidlc-cursor-adapter.ts") continue;
        const src = join(CLAUDE_SRC, sub, rel);
        if (!readFileSync(file).equals(readFileSync(src))) divergent.push(`${sub}/${rel}`);
      }
    }
    expect(divergent).toEqual([]);
  });

  test("3: rules/ holds only .mdc, and the method rule is alwaysApply naming the shipped memory tree", () => {
    // Cursor loads ONLY .mdc from .cursor/rules/ (live-verified: a plain .md
    // there is silently ignored). Anything else in the dir is a shipping bug.
    const rules = readdirSync(join(ENGINE, "rules"));
    expect(rules).toEqual(["aidlc.mdc"]);
    const rule = readFileSync(join(ENGINE, "rules", "aidlc.mdc"), "utf-8");
    expect(rule).toMatch(/^alwaysApply: true$/m);
    // The read-instruction list must name the shipped default space's method
    // files (the /aidlc space re-point rewrites these lines in place).
    for (const f of ["org.md", "team.md", "project.md", "phases/construction.md"]) {
      expect(rule).toContain(`aidlc/spaces/default/memory/${f}`);
    }
    // No @-import lines: Cursor rules do not expand them (live-verified), so
    // an @-line here would be a silent no-op masquerading as an include.
    expect(rule).not.toMatch(/^@/m);
    // And the shipped memory tree the rule points at actually ships.
    expect(existsSync(join(CURSOR_ROOT, "aidlc", "spaces", "default", "memory", "org.md"))).toBe(
      true,
    );
  });

  test("4: hooks.json wires only camelCase Cursor events, every command through the adapter", () => {
    const wiring = JSON.parse(readFileSync(join(ENGINE, "hooks.json"), "utf-8")) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(wiring.version).toBe(1);
    const events = Object.keys(wiring.hooks).sort();
    expect(events).toEqual([
      "beforeSubmitPrompt",
      "postToolUse",
      "preCompact",
      "preToolUse",
      "sessionEnd",
      "sessionStart",
      "stop",
    ]);
    const targets = new Set<string>();
    for (const [event, group] of Object.entries(wiring.hooks)) {
      // Cursor event names are camelCase; a PascalCase name (the Claude
      // schema) would silently never fire.
      expect(event[0], `${event}: camelCase`).toBe(event[0].toLowerCase());
      for (const h of group) {
        const m = h.command.match(/^bun \.cursor\/hooks\/aidlc-cursor-adapter\.ts ([a-z-]+)$/);
        expect(m, `${event}: adapter command shape (${h.command})`).not.toBeNull();
        if (m) targets.add(m[1]);
      }
    }
    // Every wired target has a real arm in the adapter switch.
    const adapter = readFileSync(join(ENGINE, "hooks", "aidlc-cursor-adapter.ts"), "utf-8");
    for (const target of targets) {
      expect(adapter, `adapter handles "${target}"`).toContain(`case "${target}":`);
    }
  });

  test("5: persona files are native-subagent-safe - no model pins, no tier leak", () => {
    const agents = readdirSync(join(ENGINE, "agents")).filter((f) => f.endsWith("-agent.md"));
    expect(agents.length).toBe(14);
    for (const f of agents) {
      const raw = readFileSync(join(ENGINE, "agents", f), "utf-8");
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      // The cursor tier column is all-null BY DESIGN (plan-dependent model
      // availability): a model pin here would hard-fail lower-plan installs.
      expect(fm, `${f}: no model pin`).not.toMatch(/^model:/m);
      expect(fm, `${f}: no raw tier: leak`).not.toMatch(/^tier:/m);
      // Cursor discovers subagents by frontmatter name; the core name key is
      // the discovery key and must survive projection.
      expect(fm, `${f}: discoverable name`).toMatch(/^name: aidlc-/m);
    }
  });

  test("6: cli.json pre-approves exactly Shell(bun) at the project level", () => {
    const cli = JSON.parse(readFileSync(join(ENGINE, "cli.json"), "utf-8")) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };
    // Project-level cli.json is permissions-only (Cursor's documented
    // contract); the shipped allowlist is the engine runner and nothing else.
    expect(cli.permissions?.allow).toEqual(["Shell(bun)"]);
    expect(cli.permissions?.deny).toEqual([]);
  });

  test("7: shipped cursor prose names no other harness's engine dir", () => {
    const r = spawnSync("grep", ["-rn", "bun .claude/tools/", CURSOR_ROOT], {
      encoding: "utf-8",
    });
    // grep exits 1 on no matches - exactly what we want.
    expect(r.status).toBe(1);
  });

  test("8: doctor recognizes a pristine dist/cursor install (adapter + wiring checks)", () => {
    const root = mkdtempSync(join(tmpdir(), "t250-cursor-doctor-"));
    try {
      const project = join(root, "project");
      cpSync(CURSOR_ROOT, project, { recursive: true });
      const r = spawnSync(
        "bun",
        [join(project, ".cursor", "tools", "aidlc-utility.ts"), "doctor", "--project-dir", project],
        {
          cwd: project,
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".cursor" },
        },
      );
      expect(r.stdout).toContain("✓  aidlc-cursor-adapter.ts present");
      expect(r.stdout).toContain("✓  hooks.json present (hook wiring)");
      expect(r.stdout).toContain("✓  cli.json present (Shell(bun) permission pre-approval)");
      expect(r.stdout).toContain(
        "✓  rules/aidlc.mdc present (method rule (alwaysApply read instruction))",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
