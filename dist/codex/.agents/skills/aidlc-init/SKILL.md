---
name: aidlc-init
generated-by: aidlc-runner-gen
description: >
  Start an AI-DLC workflow — run the whole Initialization phase (mint the
  intent, detect the workspace, build state) in one step, without typing a
  stage. The engine normally auto-births the first intent; this is opt-in
  packaging over that move. Pass `--scope <name>` to seed the initial scope
  (defaults to poc), or a freeform description of what to build.
argument-hint: "[--scope <name>] [description]"
user-invocable: true
---

# AI-DLC — start a workflow (birth the first intent)

Start a fresh AI-DLC workflow. The workspace shell ships in `dist/` (no setup
command), and the engine auto-births the first intent when you describe what to
build — this skill is opt-in packaging over that birth move. Initialization is a
PHASE, not a single stage — it mints the intent, detects the workspace
(greenfield/brownfield), and builds `aidlc-state.md` together, in one
deterministic call. There is no per-init-stage runner because an init stage has
no standalone meaning.

## Steps

1. Birth the intent (run the initialization phase). Parse the user's
   `$ARGUMENTS`: forward any recognized flags
   (`--scope <name>`/`--depth <level>`/`--test-strategy <level>`)
   as-is, and pass any freeform description text via `--arguments "<text>"`
   (`intent-birth` reads the description from the `--arguments` flag, NOT a
   positional — forwarding it bare would silently drop it). ALSO derive a short
   **`--label`**: a 2-3 word kebab-case essence of what's being built
   (`"I would like to build a simple calculator application"` → `--label
   "simple calc"`). The label becomes the readable, date-prefixed record dir name
   (`<YYMMDD>-simple-calc`); the full `--arguments` text is preserved separately
   in the audit + state. Omit `--label` only when there is no description (the
   tool then falls back to the scope token):

   ```bash
   bun .codex/tools/aidlc-utility.ts intent-birth --scope <name> --arguments "<description>" --label "<2-3 word essence>"
   ```

   `--scope` seeds the initial scope (defaults to `poc`). If the user gave
   NEITHER a scope NOR a description, do NOT run a bare `intent-birth`: the tool
   refuses it (birth is a mutation; a bare call would mint a garbage
   default-scope intent). Ask the user what they'd like to build (or which
   scope), then birth with their answer. When the user named a scope but gave no
   description, omit `--arguments` and `--label` (the dir name falls back to the
   scope token) and the engine picks up the named scope. Print the tool's output
   and stop. This does not advance a stage; run `/aidlc` afterwards to continue.
