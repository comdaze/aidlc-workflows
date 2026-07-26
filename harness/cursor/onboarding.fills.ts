// harness/cursor/onboarding.fills.ts — Cursor's onboarding-doc fills.
// Rendered with core/templates/onboarding.md by scripts/onboarding.ts into
// dist/cursor/AGENTS.md (project root — Cursor auto-reads it as plain ambient
// instructions; no @-import expansion, live-verified). {{HARNESS_DIR}} →
// .cursor is applied by the packager transform afterwards.

import type { OnboardingFills } from "../../scripts/onboarding.ts";

const fills: OnboardingFills = {
  invoke: "/aidlc",
  slots: {
    title_block: `# Project Name <!-- Replace with your project name -->

This project uses AI-DLC (AI-Driven Development Life Cycle) for structured development, running on the **Cursor harness** (the Cursor IDE and the Cursor CLI \`agent\` share this install). The workspace shell ships in \`.cursor/\` (no setup command); the engine auto-births the first intent when you describe what to build. Run \`/aidlc\` followed by a scope or project description to begin. Run \`/aidlc --doctor\` to validate your setup, \`/aidlc --version\` to print the framework version, \`/aidlc --stage <slug>\` to jump to a specific stage, \`/aidlc --phase <name>\` to jump to a phase, \`/aidlc --depth <level>\` to override depth, \`/aidlc --test-strategy <level>\` to override test volume. Run \`/aidlc compose "<task>"\` to have the adaptive composer propose a tailored EXECUTE/SKIP plan (works up front, from a scan report via \`--report <path>\`, and mid-workflow to re-shape the pending stages - every proposal stops at an approve/edit/reject gate).`,

    prereq_bullets: `- **Cursor**: the IDE, or the Cursor CLI (\`curl https://cursor.com/install -fsS | bash\`; invoked as \`agent\`). Both read this install's \`.cursor/\` surfaces (rules, skills, agents, hooks). Verified against cursor-agent 2026.07 — hooks (\`.cursor/hooks.json\`) and skills (\`.cursor/skills/\`) are current-line features.
- **A paid Cursor plan for named models**: Free accounts can only use \`Auto\`; the tiered persona surfaces ship with no model pins so every agent inherits your session model, but headless CLI runs that pass \`--model\` need a plan that allows it.
- **bun**: Required for the CLI tools and hook scripts (state management, audit logging, orchestration engine). Install via \`curl -fsSL https://bun.sh/install | bash\`. \`bun\` must be on your PATH for the shells Cursor spawns.
- **Permissions**: the shipped \`.cursor/cli.json\` pre-approves \`Shell(bun)\` so the forwarding loop's engine calls do not prompt; every other shell command follows your Cursor approval settings. In headless \`agent -p\` runs, pass \`--force\` only if you accept auto-approval of the remaining prompts; prefer interactive sessions for gated workflows.`,

    prereq_bullets_tail: "",

    agents_note: `On Cursor the persona files in \`.cursor/agents/\` are live native subagents (discovered by frontmatter \`name\`); the conductor adopts them inline for most stages and delegates via the \`task\` tool for the two subagent stages (2.1, 3.5). They ship without \`model:\` pins — every agent inherits your session model (model availability is plan-dependent on Cursor).`,

    structure_extra: "",

    guide_pointer: `The Cursor-specific guide (install, what differs, verification) is \`docs/guide/harnesses/cursor.md\`.`,

    sections_before_resumption: `## What's different on this harness

This is the same AI-DLC core that ships to every harness — one deterministic engine, state machine, audit trail, and stage set, rendered onto Cursor. On Cursor:

- Approval gates and questions render as **numbered prose options** (no structured-question widget); the questions FILE with \`[Answer]:\` tags remains the source of truth.
- Hooks ride \`.cursor/hooks.json\` through the AIDLC adapter (\`.cursor/hooks/aidlc-cursor-adapter.ts\`): the state-transition and reviewer read-scope guards block via Cursor's \`permission: deny\` channel before tools; audit and sensors cover write and edit; runtime-compile, presence minting, and pre-compaction state validation run from the matching Cursor moments.
- The forwarding-loop enforcement (the Stop hook) is **advisory**: Cursor's stop hook cannot refuse a stop, so a pending directive surfaces as a follow-up nudge instead of a block.
- The AI-DLC method (\`aidlc/spaces/<space>/memory/*.md\`) reaches context two ways: the \`.cursor/rules/aidlc.mdc\` rule (alwaysApply) instructs the agent to read the method files, and the sessionStart hook injects the live workflow state; \`/aidlc space <name>\` re-points the rule's file list in place. Cursor rules do not expand \`@\`-import lines, so the method is read, not inlined.
- Subagent identity on hook payloads is **reconstructed by the adapter** (Cursor emits no per-subagent identity): reviewer read-scope enforcement keys on the Task-spawn ledger the adapter maintains.
- There is **no statusline** and **no welcome message**; use \`/aidlc --status\` and the progress lines at gates.
- Construction swarm runs as **task-tool fan-out only** (\`AIDLC_USE_SWARM=1\` is a loud no-op).
- **Tab autocomplete** is untouched by this install — it rides Cursor's own models regardless of configuration.
- **MCP servers**: none ship (configure your own in \`.cursor/mcp.json\` if needed).
- A workflow's \`aidlc/\` workspace tree is harness-neutral: a project can move between harness installs (supported but untested — keep the trees in sync via the framework's packaging if you do this).
`,

    sections_after_resumption: "",

    gitignore_extra: "",
  },
};

export default fills;
