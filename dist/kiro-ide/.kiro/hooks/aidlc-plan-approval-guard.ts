// PreToolUse hook: deterministic enforcement of code-generation's
// plan-before-generation ordering (stage file Step 2-4).
//
// The stage prose says generation never begins before the human answers
// "Approve Plan": the conductor writes code-generation-plan.md, presents the
// Plan Approval question through code-generation-questions.md, and only an
// explicit approval authorizes the developer-agent dispatch. A field report
// showed prose losing that contest: a conductor generated the code first and
// backfilled the plan beside code-summary.md, making the plan an output
// instead of the input. The stage-completion artifact guard cannot catch
// this - it fires at completion time, when the backfilled plan already
// exists. Per the framework layering (determinism belongs in tools and
// hooks, knowledge in agents, judgement with humans), this hook is the
// ordering's deterministic twin.
//
// This is one of the framework's flow-altering hooks. Its contract is the
// harness-native PreToolUse block: print a reason to stderr and exit 2 to
// refuse the tool call, exit 0 to allow. The refusal is scoped tightly - one
// tool (the subagent dispatch), one target agent (aidlc-developer-agent),
// one stage (code-generation) - and the reason text redirects the conductor
// to the stage steps it skipped, so a blocked call is a recoverable nudge,
// not a halt.
//
// How the hook decides: the dispatch prompt names the unit being built (the
// stage file's delegation brief carries the unit's artifacts and the approved
// plan). The hook resolves the workflow's known units (the compiled bolt DAG
// when one exists, plus the on-disk construction/<unit>/ dirs - incremental
// scopes skip units-generation, so the dirs are the only unit register
// there), finds which of them the prompt mentions, and requires that at
// least one mentioned unit has BOTH its plan on disk AND its Plan Approval
// answered. A prompt that names no known unit falls back to "any unit
// approved"; a workflow with no plan anywhere - the reported failure - is
// refused outright. "Answered" mirrors the Stop hook's tag grammar
// (stage-protocol.md: a blank or underscores-only `[Answer]:` is pending):
// the questions file must carry at least one answered tag and no pending
// one, so a reset tag after "Request Changes" keeps blocking until the
// human re-approves.
//
// Deliberate carve-out: under an autonomous Construction swarm
// (`Construction Autonomy Mode: autonomous`) the hook does not enforce. The
// autonomy grant is the human's standing approval for the batch, the swarm
// referee (aidlc-swarm.ts finalize) owns per-unit verification there, and a
// deterministic block would deadlock a granted swarm on a question no one is
// present to answer.
//
// Fail-open everywhere: a missing or unreadable state file, a current stage
// other than code-generation, malformed stdin, an unknown tool, a
// non-developer subagent target, or any throw allows the call. The
// deterministic off-switch AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1 disables
// enforcement entirely (the documented escape hatch for false-positive
// storms, mirroring the reviewer-scope guard's off-switch). Every genuine
// block emits a PLAN_APPROVAL_BLOCKED audit event so the run's record shows
// when the ordering bit; audit failures never change the decision.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  auditFilePath,
  type ClaudeCodeHookInput,
  docsRoot,
  errorMessage,
  getField,
  hooksHealthDir,
  isClaudeCodeHookInput,
  isoTimestamp,
  recordHookDrop,
  releaseAuditLock,
  resolveBoltDag,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";

const HOOK_NAME = "plan-approval-guard";

// The one stage this hook guards and the one dispatch target it inspects.
const GUARDED_STAGE = "code-generation";
const GUARDED_AGENT = "aidlc-developer-agent";

// The subagent-dispatch tool names across harness payload shapes. Claude Code
// delivers Task; the adapters translate their native dispatch tools (Kiro's
// subagent stages, opencode's task, Codex's spawn_agent) into this shape.
const DISPATCH_TOOLS = new Set(["Task", "Agent"]);

// --- The pure decision --------------------------------------------------------
//
// Everything below up to the main section is side-effect free and exported so
// the decision table is unit-testable without a live session. The hook body
// only wires stdin, the state file, and the exit code around it.

/** Per-unit evidence the main body gathers from disk. */
export interface UnitEvidence {
  /** Unit-of-work name, e.g. todo-core. */
  unit: string;
  /** construction/<unit>/code-generation/code-generation-plan.md exists. */
  planExists: boolean;
  /** The unit's questions file records an answered, non-pending Plan Approval. */
  approved: boolean;
}

/** The decision's verdict. `mentioned` names the units the prompt matched. */
export interface PlanApprovalVerdict {
  block: boolean;
  mentioned: string[];
}

// Normalize a state-file stage value for comparison: the field usually holds
// the slug (code-generation) but a display-cased value (Code Generation) must
// compare equal rather than silently disable enforcement.
export function normalizeStageName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

// The Stop hook's tag grammar (stage-protocol.md): an `[Answer]:` whose value
// is blank or underscores-only is PENDING; anything else is answered.
const PENDING_TAG_RE = /\[Answer\]:[ \t]*_*[ \t]*$/m;
const TAG_RE = /\[Answer\]:[ \t]*(.*)$/gm;

/**
 * True when a questions-file body records a settled approval: at least one
 * answered `[Answer]:` tag and no pending one. A blank tag anywhere keeps the
 * file unsettled - the stage prose resets the Plan Approval tag to blank on
 * "Request Changes", so a revision round re-arms the guard until the human
 * answers again.
 */
export function questionsFileApproved(body: string): boolean {
  if (PENDING_TAG_RE.test(body)) return false;
  for (const m of body.matchAll(TAG_RE)) {
    const value = m[1].trim();
    if (value.length > 0 && !/^_+$/.test(value)) return true;
  }
  return false;
}

// Word-boundary containment for a unit name inside the dispatch prompt. Unit
// names are slug-shaped; a bare substring test would let unit "auth" match
// inside "author", so both flanks must not extend the slug alphabet.
export function promptMentionsUnit(text: string, unit: string): boolean {
  if (unit.length === 0) return false;
  const escaped = unit.replace(/[\\^$+?.()|[\]{}*]/g, "\\$&");
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "i");
  return re.test(text);
}

/**
 * The plan-approval dispatch decision. Pure: no I/O, no environment.
 *
 * Blocks when the dispatch targets the developer agent for code-generation
 * and no plausible unit has an approved plan: if the prompt names known
 * units, at least one NAMED unit must be approved (a prompt naming only an
 * unplanned unit is exactly the reported bug); if the prompt names none, any
 * approved unit passes (lenient fallback - unit naming in prose is a
 * heuristic); if the workflow knows no units at all, there is no plan
 * anywhere and the dispatch is refused.
 */
export function evaluatePlanApprovalDispatch(
  toolName: string,
  subagentType: string,
  promptText: string,
  ctx: {
    currentStage: string;
    autonomyMode: string | null;
    units: UnitEvidence[];
  },
): PlanApprovalVerdict {
  const allow: PlanApprovalVerdict = { block: false, mentioned: [] };
  if (!DISPATCH_TOOLS.has(toolName)) return allow;
  if (subagentType !== GUARDED_AGENT) return allow;
  if (normalizeStageName(ctx.currentStage) !== GUARDED_STAGE) return allow;
  if ((ctx.autonomyMode ?? "").trim().toLowerCase() === "autonomous") return allow;

  const approved = (u: UnitEvidence) => u.planExists && u.approved;
  const mentioned = ctx.units.filter((u) => promptMentionsUnit(promptText, u.unit));
  if (mentioned.length > 0) {
    return { block: !mentioned.some(approved), mentioned: mentioned.map((u) => u.unit) };
  }
  return { block: !ctx.units.some(approved), mentioned: [] };
}

// The block reason handed back to the conductor through the harness's
// PreToolUse error channel. Self-explaining and redirecting: it names the
// missing evidence and the exact stage steps that produce it, so the
// conductor self-corrects instead of retrying the same call.
export function blockReason(mentioned: string[], units: UnitEvidence[]): string {
  const scope = mentioned.length > 0
    ? `unit ${mentioned.join(", ")}`
    : units.length > 0
      ? `any unit (${units.map((u) => u.unit).join(", ")})`
      : "any unit (none found)";
  return (
    `plan-approval guard: code-generation must not dispatch ${GUARDED_AGENT} before the ` +
    `plan is written and approved for ${scope}. Follow the stage file's Steps 2-3 first: ` +
    `write <record>/construction/<unit>/code-generation/code-generation-plan.md, create ` +
    `code-generation-questions.md with a Plan Approval question and a blank [Answer]: tag, ` +
    `present that question, END the turn, and record the human's explicit "Approve Plan" ` +
    `answer in the tag. Only then dispatch generation (Step 4). ` +
    `code-generation-plan.md is the INPUT to generation, never a retroactive summary.`
  );
}

// --- Evidence gathering ---------------------------------------------------------

// The workflow's known units: the compiled bolt DAG when one resolves, plus
// every existing construction/<unit>/ dir (incremental scopes skip
// units-generation, so a conductor-chosen unit dir is the only register
// there). A malformed DAG contributes nothing - the dir listing still stands.
export function knownUnits(projectDir: string, recordDir: string): string[] {
  const units = new Set<string>();
  try {
    const dag = resolveBoltDag(projectDir);
    if (dag.state === "ok") for (const u of dag.units) units.add(u);
  } catch {
    // DAG resolution is best-effort here.
  }
  try {
    const constructionDir = join(recordDir, "construction");
    if (existsSync(constructionDir)) {
      for (const entry of readdirSync(constructionDir, { withFileTypes: true })) {
        if (entry.isDirectory()) units.add(entry.name);
      }
    }
  } catch {
    // Unreadable construction dir - the DAG set (possibly empty) stands.
  }
  return Array.from(units);
}

export function gatherUnitEvidence(recordDir: string, units: string[]): UnitEvidence[] {
  return units.map((unit) => {
    const stageDirPath = join(recordDir, "construction", unit, GUARDED_STAGE);
    const planExists = existsSync(join(stageDirPath, "code-generation-plan.md"));
    let approved = false;
    try {
      const questionsPath = join(stageDirPath, "code-generation-questions.md");
      if (existsSync(questionsPath)) {
        approved = questionsFileApproved(readFileSync(questionsPath, "utf-8"));
      }
    } catch {
      // Unreadable questions file counts as unapproved for this unit; the
      // decision stays lenient across units, and total absence of evidence is
      // the only outright block.
    }
    return { unit, planExists, approved };
  });
}

// --- Main ---------------------------------------------------------------------

if (import.meta.main) {
  // Deterministic off-switch: enforcement disabled entirely.
  if (process.env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD === "1") process.exit(0);

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, `${HOOK_NAME}.last`), isoTimestamp(), "utf-8");
  } catch {
    // Heartbeat failure is non-fatal - never let it affect the decision.
  }

  // A TTY means no harness JSON is coming (test / debug contexts) - allow.
  if (process.stdin.isTTY) process.exit(0);

  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(await Bun.stdin.text());
    if (!isClaudeCodeHookInput(raw)) process.exit(0);
    parsed = raw;
  } catch {
    process.exit(0); // malformed stdin - fail open
  }

  const toolName = parsed.tool_name ?? "";
  if (!DISPATCH_TOOLS.has(toolName)) process.exit(0);
  const toolInput = parsed.tool_input ?? {};
  const subagentType =
    typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : "";
  if (subagentType !== GUARDED_AGENT) process.exit(0);

  let verdict: PlanApprovalVerdict;
  let units: UnitEvidence[] = [];
  try {
    const statePath = stateFilePath(projectDir);
    if (!existsSync(statePath)) process.exit(0); // no workflow - fail open
    const state = readFileSync(statePath, "utf-8");
    const currentStage = getField(state, "Current Stage") ?? "";
    if (normalizeStageName(currentStage) !== GUARDED_STAGE) process.exit(0);
    const autonomyMode = getField(state, "Construction Autonomy Mode");

    const recordDir = docsRoot(projectDir);
    units = gatherUnitEvidence(recordDir, knownUnits(projectDir, recordDir));
    const promptText = [toolInput.prompt, toolInput.description]
      .filter((v): v is string => typeof v === "string")
      .join("\n");
    verdict = evaluatePlanApprovalDispatch(toolName, subagentType, promptText, {
      currentStage,
      autonomyMode,
      units,
    });
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    process.exit(0); // evidence gathering failed - fail open
  }
  if (!verdict.block) process.exit(0);

  // Audit the refusal so the run's record shows when the ordering bit.
  // Best-effort: an audit failure never changes the block decision. The lock
  // acquisition is TIME-BOUNDED well below the standard 5s budget (5 x 50ms):
  // the block decision is already made, and a dropped advisory row is
  // preferable to a slow block.
  try {
    if (existsSync(auditFilePath(projectDir))) {
      if (acquireAuditLock(projectDir, 5, 50)) {
        try {
          appendAuditEntryUnlocked(
            "PLAN_APPROVAL_BLOCKED",
            {
              Tool: toolName,
              Target: subagentType,
              Stage: GUARDED_STAGE,
              Unit: verdict.mentioned.join(", ") || "(unidentified)",
            },
            projectDir,
          );
        } finally {
          releaseAuditLock(projectDir);
        }
      } else {
        recordHookDrop(
          projectDir,
          HOOK_NAME,
          "audit lock contended; PLAN_APPROVAL_BLOCKED row dropped (block still enforced)",
        );
      }
    }
  } catch {
    // Advisory emission only.
  }

  process.stderr.write(`${blockReason(verdict.mentioned, units)}\n`);
  process.exit(2); // harness PreToolUse reject contract: exit 2 + stderr blocks
}
