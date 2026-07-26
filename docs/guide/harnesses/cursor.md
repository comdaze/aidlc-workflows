# AI-DLC on Cursor

`dist/cursor/` is one of the framework's harness distributions, for
[Cursor](https://cursor.com). One tree serves both the **Cursor IDE** and the
**Cursor CLI** (`agent`): they share the same `.cursor/` discovery. One
deterministic core, many harnesses: the engine, state machine, audit log,
graph, swarm referee, and learnings gate are byte-identical across every
distribution - only the shell differs. The tree is **generated** from `core/` +
`harness/cursor/` by `bun scripts/package.ts cursor`; never hand-edit it (the
drift guard fails CI).

## Layout

Cursor is the most "native" port so far - it consumes the standard core
projection directly (no `emit.ts`, no split dot-dir). The distribution is:

- **`.cursor/`** - the framework tree. Cursor reads only a few subdirs as
  native meaning: `rules/` (the method rule), `agents/` (the 14 personas as
  native subagents), `skills/` (the orchestrator and generated stage runners),
  `hooks.json` + `hooks/` (the hook wiring and adapter), `cli.json`
  (permissions), and `mcp.json` (MCP servers, if you add one). The engine dirs
  beside them (`tools/`, `aidlc-common/`, `knowledge/`, `sensors/`, `scopes/`)
  are inert data to Cursor and safely share the directory.
- **`aidlc/`** - the workspace shell (the pre-built
  `aidlc/spaces/default/memory/` method tree the engine reads), a sibling of
  `.cursor/`.
- **`AGENTS.md`** - project-root ambient instructions Cursor auto-reads.

## Prerequisites

- **Cursor** - the IDE, or the Cursor CLI (install with
  `curl https://cursor.com/install -fsS | bash`; invoked as `agent`). Both read
  this install's `.cursor/` surfaces. Verified against cursor-agent 2026.07;
  hooks (`.cursor/hooks.json`) and skills (`.cursor/skills/`) are
  current-line features.
- **bun** - same requirement as every harness; every tool and hook runs via
  bun. `bun` must be on the PATH the shells Cursor spawns can see.
- **A paid Cursor plan for named models** - Free accounts can only use `Auto`.
  The tiered persona surfaces ship with **no model pins** (all tiers project to
  null on Cursor: model availability is plan-dependent), so every agent
  inherits your session model. Headless CLI runs that pass `--model` need a
  plan that allows it. Bedrock BYOK is IDE-only: static keys on Pro, an IAM role
  on Teams (doc-verified against Cursor's model settings, not live-verified
  here); the CLI routes models through Cursor's own backend.

## Install

1. Copy the distribution into your project:

   ```bash
   cp -r dist/cursor/.cursor/ your-project/.cursor/
   cp -r dist/cursor/aidlc/   your-project/aidlc/     # the workspace shell - a sibling of .cursor/, not inside it
   cp dist/cursor/AGENTS.md   your-project/AGENTS.md  # or merge into yours
   ```

   The `aidlc/` shell ships the pre-built `aidlc/spaces/default/memory/` method
   tree the engine reads; `/aidlc --doctor` fails its "workspace shell ready"
   check without it.

2. Apply the `.gitignore` entries from the shipped `AGENTS.md` § "Git
   Integration" before starting a workflow (per-clone audit shards are committed
   deliberately; per-user cursors and machine-local runtime stay ignored).

3. Open the project in the Cursor IDE (or start `agent` in it) and run
   `/aidlc --doctor`, then `/aidlc` followed by what you want to build.

## What's different on this harness

- **Questions render as numbered prose options** (no structured-question
  widget); the questions FILE with `[Answer]:` tags remains the source of
  truth.
- **Hooks ride `.cursor/hooks.json`** through the AIDLC adapter
  (`.cursor/hooks/aidlc-cursor-adapter.ts`), which maps Cursor's camelCase hook
  events (`sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `preToolUse`,
  `postToolUse`, `preCompact`, `stop`) onto the byte-shared core hook bodies
  (run as bun subprocesses): presence minting on each human turn, the
  state-transition and reviewer read-scope guards before a tool runs, audit +
  sensors on write/edit, runtime-compile on shell, and state validation before
  compaction. The **PreToolUse guards block** via Cursor's
  `{"permission":"deny","agent_message":...}` stdout channel. Cursor names its
  shell tool `Shell`; the adapter maps it to the core hooks' `Bash`.
- **Forwarding-loop enforcement is advisory.** Cursor's `stop` hook cannot
  refuse a stop, so when the core stop hook answers `block` the adapter surfaces
  a follow-up nudge instead (the same posture as opencode). The forwarding loop
  in the conductor skill is the real discipline.
- **A real session-end moment exists** (unlike Codex): `sessionEnd` fires, so
  `SESSION_ENDED` audit events are emitted. Pre-compaction validation also fires
  (`preCompact`).
- **Personas are native subagents.** The 14 persona `.md` files in
  `.cursor/agents/` are discovered by frontmatter `name`; the conductor adopts
  them inline for most stages and delegates via the `task` tool for the two
  subagent stages (2.1 reverse-engineering, 3.5 code-generation). Worker agents
  do not get the `task` tool, so a delegate cannot delegate again.
- **Subagent identity is reconstructed.** Cursor emits no per-subagent identity
  on hook payloads (its `subagentStart`/`subagentStop` events are documented but
  never fire on the CLI), so the adapter maintains a Task-spawn tmpdir ledger
  and keys reviewer read-scope enforcement off it.
- **The method rule is a read instruction, not an import.** Cursor rules do not
  expand `@`-import lines, so `.cursor/rules/aidlc.mdc` (`alwaysApply`) tells the
  agent to read `aidlc/spaces/<space>/memory/*.md`, and the `sessionStart` hook
  injects the live workflow context. `/aidlc space <name>` re-points the rule's
  file list in place.
- **Construction swarm runs as task-tool fan-out only** (`AIDLC_USE_SWARM=1` is
  a loud no-op - no Workflow tool exists).
- **No statusline / welcome message** - use `/aidlc --status` and the progress
  lines at gates.
- **Tab autocomplete is untouched** by this install - it rides Cursor's own
  models regardless of configuration.
- **Permissions**: `.cursor/cli.json` pre-approves `Shell(bun)` only (a
  project-level `cli.json` carries permissions only); every other shell command
  follows your Cursor approval settings.
- **MCP servers**: none ship; configure your own under `.cursor/mcp.json` if
  needed.

## Verifying an install

```bash
bun .cursor/tools/aidlc-utility.ts doctor        # all checks pass on a fresh copy
agent -p "/aidlc --status" --output-format text --trust   # /aidlc --status through the CLI
```

The doctor's Cursor-specific checks: the hook wiring at `.cursor/hooks.json`,
the `Shell(bun)` permission pre-approval at `.cursor/cli.json`, and the method
rule at `.cursor/rules/aidlc.mdc`.

> **Scripting trap: Cursor CLI always exits 0.** Headless `agent -p "<prompt>"
> --output-format text --trust` returns exit code 0 even when the run errors, so
> a CI check must assert on the emitted text, never on the exit status. Named
> models (`--model`) need a paid plan; without one, use `Auto`.

## Next steps

Installed and verified? The methodology is the same on every harness - keep
going with the neutral chapters:

- [Your First Workflow](../02-your-first-workflow.md) - an annotated end-to-end run.
- [Phases and Stages](../04-phases-and-stages.md) - the 5 phases and 32 stages.
- [Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) - right-sizing a run.
- [Glossary](../glossary.md) - every term defined.

Other harnesses: [AI-DLC on opencode](opencode.md) · [the harness family index](README.md).
