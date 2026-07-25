// PreToolUse hook: refuse direct lifecycle mutations through aidlc-state.ts.
//
// The orchestration engine owns stage pinning, evidence checks, idempotency,
// and transition selection. A conductor that calls state transition verbs
// directly bypasses that boundary. Read-only state queries and specialized
// recovery/configuration verbs remain available.

import {
  type ClaudeCodeHookInput,
  isClaudeCodeHookInput,
} from "../tools/aidlc-lib.ts";

export const BLOCKED_STATE_TRANSITIONS = new Set([
  "set",
  "checkbox",
  "advance",
  "finalize",
  "complete-workflow",
  "gate-start",
  "approve",
  "reject",
  "revise",
  "skip",
  "park",
]);

function maskMultilineQuotedStrings(command: string): string {
  const chars = [...command];
  for (let i = 0; i < chars.length; i++) {
    const quote = chars[i];
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;
    let end = i + 1;
    let escaped = false;
    for (; end < chars.length; end++) {
      const ch = chars[end];
      if (quote !== "'" && !escaped && ch === "\\") {
        escaped = true;
        continue;
      }
      if (!escaped && ch === quote) break;
      escaped = false;
    }
    if (end >= chars.length) end = chars.length - 1;
    if (chars.slice(i, end + 1).includes("\n")) {
      for (let j = i; j <= end; j++) {
        if (chars[j] !== "\n") chars[j] = " ";
      }
    }
    i = end;
  }
  return chars.join("");
}

function maskHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (pending.length > 0) {
      const active = pending[0];
      const candidate = active.stripTabs
        ? lines[i].replace(/^\t+/, "")
        : lines[i];
      lines[i] = " ".repeat(lines[i].length);
      if (candidate === active.delimiter) pending.shift();
      continue;
    }
    const heredoc = /<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g;
    for (const match of lines[i].matchAll(heredoc)) {
      const delimiter = match[2] ?? match[3] ?? match[4];
      if (delimiter) {
        pending.push({ delimiter, stripTabs: match[1] === "-" });
      }
    }
  }
  return lines.join("\n");
}

function maskFunctionDefinitions(command: string): string {
  // No brace, no function body to mask. Heredoc/quote masking has already
  // blanked embedded documents, so this bail covers the common large-write
  // command whose only real shell text is the first line.
  if (!command.includes("{")) return command;
  const chars = [...command];
  const source = () => chars.join("");
  // [ \t]* (not \s*) after the anchor: \s* spans newlines, so on a command
  // whose masked heredoc body is thousands of blank-ish lines every anchor
  // rescans the remaining whitespace run — quadratic, and slow enough to trip
  // harness hook timeouts. Same-line whitespace keeps identical coverage (a
  // definition preceded by blank lines anchors at the nearest newline).
  const definition =
    /(?:^|[;\n])[ \t]*(?:(?:function[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*\([ \t]*\)|function[ \t]+[A-Za-z_][A-Za-z0-9_]*)[ \t\n]*\{/g;
  let match = definition.exec(source());
  while (match !== null) {
    const open = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    let quote = "";
    let escaped = false;
    let end = open;
    for (; end < chars.length; end++) {
      const ch = chars[end];
      if (quote) {
        if (quote !== "'" && !escaped && ch === "\\") {
          escaped = true;
          continue;
        }
        if (!escaped && ch === quote) quote = "";
        escaped = false;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    const start = match.index +
      (match[0].startsWith(";") || match[0].startsWith("\n") ? 1 : 0);
    for (let i = start; i <= end; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
    definition.lastIndex = end + 1;
    match = definition.exec(source());
  }
  return chars.join("");
}

function executableShellText(command: string): string {
  return maskFunctionDefinitions(
    maskHeredocBodies(maskMultilineQuotedStrings(command)),
  );
}

export function directStateTransition(command: string): string | null {
  // Only inspect shell command positions: start-of-input or immediately after
  // a command separator. Matching arbitrary whitespace would mistake
  // `echo bun ... aidlc-state.ts approve` and similar search strings for an
  // invocation. The state CLI repeats this ownership check as the hard floor.
  // [ \t]* after the anchor, not \s*: \n is already in the anchor class, and a
  // cross-line \s* rescans masked heredoc whitespace quadratically (see
  // maskFunctionDefinitions). The path-prefix class likewise excludes the
  // anchor characters { and ( : a long run of either is a run of anchor
  // positions, and a prefix class that can consume the run makes every anchor
  // rescan the remainder - the same quadratic through a different door.
  // Unquoted { and ( are shell metacharacters, not path text, so coverage is
  // unchanged.
  const invocation =
    /(?:^|&&|\|\||[;|(\n{])[ \t]*(?:(?:command|exec)\s+)?(?:env(?:\s+-[^\s]+)*\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)\s+)*(?:[^\s"';&|({]+\/)?bun(?:\.exe)?(?:\s+run)?\s+(?:"[^"\n]*aidlc-state\.ts"|'[^'\n]*aidlc-state\.ts'|[^\s;&|]*aidlc-state\.ts)\s+([a-z][a-z0-9-]*)\b/g;
  for (const match of executableShellText(command).matchAll(invocation)) {
    const verb = match[1];
    if (BLOCKED_STATE_TRANSITIONS.has(verb)) return verb;
  }
  return null;
}

/** The dispatchable body (`aidlc hook state-transition-guard` requires an
 *  exported run(input)). Returns the exit code instead of process.exit so the
 *  compiled-binary route can relay the block; the CLI entry below preserves
 *  the direct-run contract (exit 2 + reason on stderr) byte-for-byte. */
export async function run(input: string): Promise<number> {
  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(input);
    if (!isClaudeCodeHookInput(raw)) return 0;
    parsed = raw;
  } catch {
    return 0;
  }
  if (parsed.tool_name !== "Bash") return 0;
  const verb = directStateTransition(parsed.tool_input?.command ?? "");
  if (verb === null) return 0;

  process.stderr.write(
    `Direct aidlc-state.ts ${verb} is blocked: workflow lifecycle transitions are engine-owned. ` +
      "Use aidlc-orchestrate.ts report --stage <slug> --result " +
      "<awaiting-approval|approved|rejected|revised|completed|skipped>; use " +
      "aidlc-orchestrate.ts park to park, and next/jump for routing changes.\n",
  );
  return 2;
}

if (import.meta.main) {
  if (process.stdin.isTTY) process.exit(0);
  process.exit(await run(await Bun.stdin.text()));
}
