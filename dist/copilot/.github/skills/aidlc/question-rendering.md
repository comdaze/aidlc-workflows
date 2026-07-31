# Question Rendering — Copilot harness annex

This file defines how THIS harness renders the structured questions that
`aidlc-common/protocols/stage-protocol.md` § "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Mechanism

Both Copilot surfaces expose a native question picker, but the tool names and
schemas differ. Use the native tool available in the active surface:

- **Copilot CLI:** `ask_user`
- **VS Code agent mode:** `vscode/askQuestions` (tool reference
  `askQuestions`)

Do not render numbered prose when either native tool is available. Numbered
prose is only the fallback for a session where the tool is absent or disabled
(for example CLI `--no-ask-user`) or a tool call fails.

### Copilot CLI — `ask_user`

The CLI schema is `question: string`, `choices: string[]`, and
`allow_freeform: boolean`.

| Spec field | `ask_user` field |
|------------|------------------|
| `header` + `prompt` | `question` (header first) |
| `options[]` | `choices[]`, in spec order |
| free-text escape | `allow_freeform: true` |

The CLI has no separate option-description field. Render each choice as
`<label> — <description>` so the human sees both parts, then map the returned
choice back to the source option's exact `label` before recording or reporting
it. For `multiSelect: true`, keep `allow_freeform: true` and tell the human in
the question text that they may enter multiple exact labels; do not invent a
`Done` option.

### VS Code — `vscode/askQuestions`

Pass one object in the tool's `questions` array:

| Spec field | `vscode/askQuestions` field |
|------------|------------------------------------|
| `header` | `questions[].header` |
| `prompt` | `questions[].question` |
| `multiSelect` | `questions[].multiSelect` |
| `options[].label` | `questions[].options[].label` |
| `options[].description` | `questions[].options[].description` |
| recommended option | `questions[].options[].recommended: true` |
| free-text escape | `questions[].allowFreeformInput: true` |

Preserve option order unless the spec identifies a recommended option; then
put that option first. The native free-text input is the `Other` escape, so do
not add an explicit `Other` option.

### Numbered-prose fallback

Only when neither native tool can be called, render:

```
**Approval** — [Stage Name] complete. How would you like to proceed?

1. **Approve** — Continue to [next stage]
2. **Request Changes** — Provide revision feedback
3. **Other** — describe what you want instead

Reply with a number (or just tell me).
```

For `multiSelect: true`, say "Reply with all numbers that apply (e.g. 1, 3)."

Rules (all tracks):

- **Approval gate `[next stage]`**: render the `Continue to [next stage]`
  placeholder from the run-stage directive's `next_stage` field verbatim
  (e.g. `Continue to NFR Requirements`); render `Complete workflow` when
  `next_stage` is null. Never guess the next stage.
- **Answer capture**: map the response to the exact source option `label` and
  record that label verbatim (protocol: never summarize User Input). A
  free-text reply that clearly matches an option counts as that option;
  anything else is an `Other` answer — discuss it, then re-ask for a final pick.
- **No emergent options**: render exactly the spec's options plus the native or
  prose free-text escape.
- **Batching**: VS Code may carry several specs in one `questions` array.
  `ask_user` asks one question per call. Keep batches readable — at most four
  questions per turn. The questions FILE remains the authoritative record.
- A skipped, cancelled, or automatic tool response is not human approval.
  Preserve the protocol's hard turn stop and wait for an explicit human choice.
