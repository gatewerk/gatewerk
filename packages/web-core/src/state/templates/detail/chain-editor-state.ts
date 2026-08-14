import type { ChainDefinition, StepRejectionPolicy, Priority } from "@gatewerk/shared";
import { MAX_CHAIN_STEPS_OSS } from "@gatewerk/shared";

// Re-export so consumers can import from one place.
export const MAX_STEPS = MAX_CHAIN_STEPS_OSS;

// Working draft of one step inside the chain editor. Decoupled from the wire
// shape (ChainDefinitionStep) because the UI:
//   * separates assignee discriminated-union into mode + email + role for a
//     toggle UI (one input visible at a time per row);
//   * uses string state for numeric inputs so partial typing doesn't fight
//     React's value-coercion (e.g. typing "1" then "0" reads as "10" not 10).
//
// Callers drive lifecycle: seed via `seedSteps`, mutate via `updateStep`, then
// `buildChainConfig` collapses the working state into a wire-shaped
// ChainDefinition (or null when there are no steps to persist).

export type AssigneeMode = "user" | "role" | "external_token";
export type AssigneeRole = "admin" | "reviewer";

export interface WorkingStep {
  // Stable React key. Not the persisted step.id — that's `stepId`. Generated
  // fresh on add (so reorder doesn't lose key identity); regenerated on seed.
  rowKey: string;
  // Human-readable display name. Primary input in the editor UI. When set, the
  // wire payload carries `name` and the inbox stepper shows it as the label.
  stepName: string;
  // step.id on the wire. 1-64 chars [a-z0-9_-]. Auto-derived from stepName
  // (slugified) unless the user manually edits it.
  stepId: string;
  // Once the user hand-edits the ID field, stop auto-syncing from stepName.
  idManuallyEdited: boolean;
  // `template` is GONE (C1, route model). A chain resolves one entry template
  // and every step reviews the same request against it, so a per-step template
  // is not a thing a step has. buildChainConfig deletes the key on save; the
  // engine ignores it on a legacy config either way.
  assigneeMode: AssigneeMode;
  assigneeEmail: string;
  assigneeRole: AssigneeRole;
  // timeout_seconds is NOT modelled here. It is roadmap tier (S4), the step card
  // renders no control for it, and the old minutes field was lossy in both
  // directions: the wire allows any integer of 60 or more, so 90 seconds seeded
  // as "2" minutes and saved back as 120. It now rides through `_stepRaw`
  // untouched. Re-modelling it means re-deriving from seconds, not minutes.
  rejectionPolicy: StepRejectionPolicy;
  // 1-based step_number reference. null when policy != "branch".
  // No control renders either of these two — both are roadmap tier — but they
  // stay in working state because `moveStep` has to remap a branch target when
  // the operator reorders steps, and `buildChainConfig` has to keep a policy
  // and its target consistent on the way out.
  rejectionBranchTo: number | null;
  // External-token assignee sub-fields (only meaningful when assigneeMode === "external_token").
  // Displayed as plain-text inputs; empty string means "not set" (field omitted on wire).
  externalTokenExpiresInSeconds: string;   // whole-number string of seconds (e.g. "86400")
  externalTokenGracePeriodSeconds: string; // whole-number string of seconds
  externalTokenNote: string;
  // Lossless stash of the full raw external_token assignee spec loaded from the wire.
  // buildChainConfig spreads this FIRST, then overwrites only the fields the editor exposes,
  // so unknown/unedited fields (auth_level, auth_email, auth_user_id, etc.) survive round-trips.
  // CRITICAL, and now the ONLY thing carrying the whole spec: S4 removed the
  // external-token sub-panel (Expires, Grace, Note) and dropped Token from the
  // assignee toggle, because external-recipient chain steps are held at roadmap
  // tier. A step the API assigned to an external recipient is rendered read only
  // and saved back from this stash. Nothing else re-creates it.
  _externalTokenRaw: Record<string, unknown> | null;
  // Lossless stash of a kind="user" assignee, the twin of `_externalTokenRaw`.
  // Carries user_id, which the editor exposes no control for.
  _userRaw: Record<string, unknown> | null;
  // Advanced per-step fields (optional; collapsed by default in the UI).
  description: string;
  priority: Priority | "";
  // Lossless stash of the full raw wire step loaded from chain_config, the
  // step-level twin of `_externalTokenRaw`. buildChainConfig spreads this FIRST
  // and then overwrites only the fields the editor exposes, so axes with no
  // control (depends_on, metadata, and every roadmap-tier key a future edition
  // adds) survive an edit instead of being dropped on save.
  // CRITICAL: reverse order would silently delete them.
  //
  // S4 made this load-bearing rather than defensive. The step card now renders
  // six controls (name, id, template, assignee, description, priority), so this
  // stash is the ONLY carrier for:
  //   timeout_seconds     roadmap — no control, no reader (the worker filters on
  //                       expires_at, which materializeStep never writes)
  //   parallel_group      roadmap
  //   condition           roadmap
  //   depends_on          inert — reference-validated, never read
  //   metadata            request tier
  // rejection_policy and rejection_branch_to are the exception: they are roadmap
  // too, but buildChainConfig writes them from working state so a reorder can
  // remap the branch target, so they are seeded above rather than left here.
  // draft-config-preservation.test.ts is the gate on all of it.
  _stepRaw: Record<string, unknown> | null;
  // Lossless stash of the chain ENVELOPE — everything in chain_config that is
  // not the steps array. The envelope twin of `_stepRaw`, and it was missing:
  // buildChainConfig used to rebuild the envelope from a four-key literal, so a
  // chain-level name, description, metadata, parallel_groups or extensions set
  // over the API was destroyed by any save from this editor, and version / mode
  // / rejection_policy were force-reset to their defaults no matter what had
  // been loaded. The per-step commentary above was careful about exactly this
  // failure mode fourteen lines earlier; the envelope simply had no stash.
  //
  // Held per step rather than beside the array so `buildChainConfig(steps)`
  // keeps its signature and every caller stays unchanged. Every seeded step
  // carries the same envelope, so removing individual rows cannot lose it.
  // Replacing ALL seeded rows with fresh ones does drop it, which is correct:
  // at that point nothing of the loaded chain remains.
  _definitionRaw: Record<string, unknown> | null;
}

export interface BuildResult {
  // null when the user removed every row — caller submits chain_config: null
  // to clear the chain on the template.
  config: ChainDefinition | null;
  errors: ValidationErrors;
}

// Per-row, per-field error messages. Keys are "<rowIndex>.<field>" so the row
// component can look up its own errors without scanning the whole map.
export type ValidationErrors = Record<string, string>;

// Default-seeded fresh step. Used when adding a row to the working draft.
let rowKeyCounter = 0;
function nextRowKey(): string {
  rowKeyCounter += 1;
  return `row_${rowKeyCounter}_${Date.now().toString(36)}`;
}

export function nameToId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

// Wire-step keys this editor itself writes on save (see buildChainConfig
// below). Anything else present in `_stepRaw` with a defined value is a
// setting no control here can show or change; it only survives a save
// because buildChainConfig spreads the raw stash first. "template" is
// retired (C1, route model) rather than a hidden control, so it is excluded
// rather than flagged.
const STEP_EDITOR_KEYS = new Set([
  "id",
  "template",
  "assignee",
  "rejection_policy",
  "rejection_branch_to",
  "name",
  "description",
  "priority",
]);

// Friendly names for the axes this file's own comments already name as
// roadmap tier with no control (timeout_seconds, depends_on, metadata,
// parallel_group, condition — see WorkingStep._stepRaw above). An
// unrecognised key still surfaces, under its raw wire name, rather than
// being silently swallowed.
const STEP_AXIS_LABELS: Record<string, string> = {
  timeout_seconds: "a timeout",
  depends_on: "a dependency on another step",
  metadata: "metadata",
  parallel_group: "a parallel group",
  condition: "a condition",
};

/**
 * Names what a step carries beyond the fields this editor renders a control
 * for. Takes the raw wire-shaped step object directly — `WorkingStep._stepRaw`
 * while editing, or a persisted `ChainDefinition["steps"][number]` straight
 * from the template when there is no working draft — because both are the
 * same shape: `_stepRaw` is nothing but a copy of the persisted step taken at
 * seed time (see `seedSteps`). One detection, fed from either source, so the
 * read-only list, the editing row, and the step modal never grow three
 * answers to "does this step carry something invisible". Preserved is good,
 * invisible is not: this is what turns that invisible carry-through into a
 * fact an author can actually see. Returns human labels; empty when the step
 * carries nothing beyond what the editor already shows.
 */
export function hiddenStepAxes(raw: Record<string, unknown> | null | undefined): string[] {
  if (!raw) return [];
  return Object.keys(raw)
    .filter((key) => !STEP_EDITOR_KEYS.has(key) && raw[key] !== undefined && raw[key] !== null)
    .map((key) => STEP_AXIS_LABELS[key] ?? key);
}

/**
 * `hiddenStepAxes`, joined into one human-readable phrase ("a timeout and a
 * condition"), or null when there is nothing to say. One formatting rule,
 * shared by every caller that names what a step carries (ChainStepModal, and
 * both the editing and read-only rows in ChainSection).
 */
export function describeHiddenStepAxes(raw: Record<string, unknown> | null | undefined): string | null {
  const axes = hiddenStepAxes(raw);
  if (axes.length === 0) return null;
  if (axes.length === 1) return axes[0];
  if (axes.length === 2) return `${axes[0]} and ${axes[1]}`;
  return `${axes.slice(0, -1).join(", ")}, and ${axes[axes.length - 1]}`;
}

export function blankStep(): WorkingStep {
  return {
    rowKey: nextRowKey(),
    stepName: "",
    stepId: "",
    idManuallyEdited: false,
    assigneeMode: "user",
    assigneeEmail: "",
    assigneeRole: "reviewer",
    rejectionPolicy: "abort",
    rejectionBranchTo: null,
    externalTokenExpiresInSeconds: "",
    externalTokenGracePeriodSeconds: "",
    externalTokenNote: "",
    _externalTokenRaw: null,
    _userRaw: null,
    description: "",
    priority: "",
    _stepRaw: null,
    // A fresh row belongs to no loaded chain. buildChainConfig reads the
    // envelope from the first row that has one.
    _definitionRaw: null,
  };
}

// Hydrate working state from a persisted ChainDefinition. Called on enter-edit
// and on prop changes when the underlying template's chain_config replaces.
export function seedSteps(config: ChainDefinition | null | undefined): WorkingStep[] {
  if (!config || !config.steps) return [];
  // Everything on the envelope except the steps array, which buildChainConfig
  // rebuilds from working state. See WorkingStep._definitionRaw.
  const { steps: _steps, ...definitionRaw } = config as Record<string, unknown> & {
    steps: unknown;
  };
  return config.steps.map((s) => {
    const assignee = s.assignee;

    let assigneeMode: AssigneeMode;
    let assigneeEmail = "";
    let assigneeRole: AssigneeRole = "reviewer";
    let externalTokenExpiresInSeconds = "";
    let externalTokenGracePeriodSeconds = "";
    let externalTokenNote = "";
    let _externalTokenRaw: Record<string, unknown> | null = null;
    let _userRaw: Record<string, unknown> | null = null;

    if (assignee.kind === "role") {
      assigneeMode = "role";
      assigneeRole = assignee.role;
    } else if (assignee.kind === "external_token") {
      assigneeMode = "external_token";
      // Stash the FULL raw spec so buildChainConfig can spread it first and
      // preserve any field the basic editor doesn't expose (auth_level, etc.).
      _externalTokenRaw = { ...assignee } as Record<string, unknown>;
      externalTokenExpiresInSeconds = assignee.expires_in_seconds != null
        ? String(assignee.expires_in_seconds) : "";
      externalTokenGracePeriodSeconds = assignee.grace_period_seconds != null
        ? String(assignee.grace_period_seconds) : "";
      externalTokenNote = assignee.note ?? "";
    } else {
      // kind === "user"
      assigneeMode = "user";
      assigneeEmail = assignee.email ?? "";
      // UserAssigneeSchema permits user_id alongside email, and the editor
      // renders no control for it, so it needs the same stash treatment the
      // external_token branch already gets. Without it buildChainConfig
      // reconstructed `{ kind: "user", email }` from scratch and the id — the
      // stable identifier, where email is merely the current address — was
      // dropped on every save. The exotic assignee kind was preserved and the
      // core one was not.
      _userRaw = { ...assignee } as Record<string, unknown>;
    }

    return {
      rowKey: nextRowKey(),
      stepName: s.name ?? "",
      stepId: s.id,
      idManuallyEdited: true,
      assigneeMode,
      assigneeEmail,
      assigneeRole,
      rejectionPolicy: s.rejection_policy ?? "abort",
      rejectionBranchTo: s.rejection_branch_to ?? null,
      externalTokenExpiresInSeconds,
      externalTokenGracePeriodSeconds,
      externalTokenNote,
      _externalTokenRaw,
      _userRaw,
      description: s.description ?? "",
      priority: (s.priority ?? "") as Priority | "",
      _stepRaw: { ...s } as Record<string, unknown>,
      _definitionRaw: definitionRaw,
    };
  });
}

// Steps with index strictly less than `currentRowIndex`, returned as 1-based
// {value, label} pairs for the rejection_branch_to picker. Hides the current
// row and any row after it — branch_to must be < current step_number to avoid
// cycles (zod refinement enforces the same; this is the client mirror).
//
// NOT dead code, and not to be deleted: S4 removed the "Branch to" select from
// the step card because rejection branching is roadmap tier, so this currently
// has no caller outside its own tests. It is the picker's filter, kept intact
// for the edition that ships branching. Held features are inventory, not debt.
export interface BranchTarget {
  stepNumber: number;
  label: string;
}

export function getEarlierSteps(
  steps: WorkingStep[],
  currentRowIndex: number,
): BranchTarget[] {
  const out: BranchTarget[] = [];
  for (let i = 0; i < currentRowIndex && i < steps.length; i++) {
    const stepNumber = i + 1;
    const label = steps[i].stepName.trim() || steps[i].stepId.trim() || `Step ${stepNumber}`;
    out.push({ stepNumber, label });
  }
  return out;
}

// Apply a partial update to one row in the working draft. When the user
// switches policy AWAY from "branch", clear branch_to in the same transaction
// so a stale value doesn't sneak through to the wire payload (caller-side
// invariant; build also enforces, but clearing keeps the UI honest).
export function applyStepPatch(
  steps: WorkingStep[],
  rowIndex: number,
  patch: Partial<WorkingStep>,
): WorkingStep[] {
  return steps.map((s, i) => {
    if (i !== rowIndex) return s;
    const next = { ...s, ...patch };
    if (patch.rejectionPolicy && patch.rejectionPolicy !== "branch") {
      next.rejectionBranchTo = null;
    }
    return next;
  });
}

// Collapse working state → wire-shaped ChainDefinition. Returns null when
// there are no rows (caller submits chain_config: null to clear).
//
// Validation surfaces as inline per-field messages keyed "<rowIdx>.<field>".
// Server-side zod will catch anything we miss, but the inline pre-check keeps
// the UX off the network for trivial mistakes (empty template slug, missing
// branch target, etc.).
export function buildChainConfig(steps: WorkingStep[]): BuildResult {
  if (steps.length === 0) return { config: null, errors: {} };

  const errors: ValidationErrors = {};
  const seenIds = new Set<string>();
  const wireSteps: ChainDefinition["steps"] = [];

  steps.forEach((s, i) => {
    const fallbackId = `step_${i + 1}`;
    const id = (s.stepId.trim() || fallbackId).toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) {
      errors[`${i}.stepId`] = "Step ID must be 1 to 64 lowercase letters, digits, underscores, or hyphens.";
    }
    if (seenIds.has(id)) {
      errors[`${i}.stepId`] = `Step ID '${id}' is already used by an earlier step.`;
    }
    seenIds.add(id);

    let assignee: ChainDefinition["steps"][number]["assignee"];
    if (s.assigneeMode === "user") {
      const email = s.assigneeEmail.trim();
      if (!email) {
        errors[`${i}.assigneeEmail`] = "Reviewer email is required.";
      }
      // Spread the stash FIRST, then overwrite the one field the editor
      // exposes — same order, and for the same reason, as the external_token
      // branch below. Reversed, user_id would be dropped on every save.
      assignee = { ...(s._userRaw ?? {}), kind: "user", email } as ChainDefinition["steps"][number]["assignee"];
    } else if (s.assigneeMode === "role") {
      assignee = { kind: "role", role: s.assigneeRole };
    } else {
      // external_token: spread _externalTokenRaw FIRST to preserve unknown/unedited
      // fields, then overwrite only the fields this editor exposes.
      // CRITICAL: reverse order would silently drop auth_level, auth_email, etc.
      const raw: Record<string, unknown> = { ...(s._externalTokenRaw ?? {}), kind: "external_token" };
      const expiresRaw = s.externalTokenExpiresInSeconds.trim();
      if (expiresRaw) {
        const v = Number(expiresRaw);
        if (Number.isFinite(v) && v >= 1) raw.expires_in_seconds = Math.round(v);
      } else {
        delete raw.expires_in_seconds;
      }
      const graceRaw = s.externalTokenGracePeriodSeconds.trim();
      if (graceRaw) {
        const v = Number(graceRaw);
        if (Number.isFinite(v) && v >= 0) raw.grace_period_seconds = Math.round(v);
      } else {
        delete raw.grace_period_seconds;
      }
      const noteVal = s.externalTokenNote.trim();
      if (noteVal) {
        raw.note = noteVal;
      } else {
        delete raw.note;
      }
      assignee = raw as ChainDefinition["steps"][number]["assignee"];
    }

    let rejection_branch_to: number | undefined;
    if (s.rejectionPolicy === "branch") {
      if (s.rejectionBranchTo == null) {
        errors[`${i}.rejectionBranchTo`] = "Pick the step to branch back to.";
      } else if (s.rejectionBranchTo >= i + 1) {
        // Cycle prevention mirrors the zod refinement. Should never trigger in
        // practice because the picker only offers earlier steps, but defends
        // against hand-crafted state mutations.
        errors[`${i}.rejectionBranchTo`] = "Branch target must be a step before this one.";
      } else {
        rejection_branch_to = s.rejectionBranchTo;
      }
    }

    const name = s.stepName.trim() || undefined;
    const description = s.description.trim() || undefined;
    const priority = s.priority || undefined;

    // Spread the raw wire step FIRST so unmodelled axes (timeout_seconds,
    // depends_on, metadata, anything a later edition adds) ride through, then
    // overwrite every field the editor exposes. Optional fields are DELETED
    // rather than skipped when the working state has cleared them — skipping
    // would let the raw value resurrect and make the control look broken.
    // Only fields with a live control are eligible for that delete: an axis with
    // no control has no cleared state to honour, so touching it is deletion.
    const wireStep: Record<string, unknown> = { ...(s._stepRaw ?? {}) };
    wireStep.id = id;
    // C1: retired. Deleted rather than left riding through the raw stash,
    // because a stale slug in a saved config invites the reader to believe a
    // step still chooses its own form. The route's entry template is the
    // template this chain hangs off.
    delete wireStep.template;
    wireStep.assignee = assignee;
    // Only written when it is NOT the default. The editor renders no control
    // for this, and the surface-tier registry records the launch posture as
    // "NULL means abort" — writing an explicit value from a control that does
    // not exist made an API-authored NULL come back set after any save from
    // this screen. An API-set 'continue' or 'branch' still round-trips.
    if (s.rejectionPolicy && s.rejectionPolicy !== "abort") {
      wireStep.rejection_policy = s.rejectionPolicy;
    } else {
      delete wireStep.rejection_policy;
    }
    if (name) wireStep.name = name; else delete wireStep.name;
    if (description) wireStep.description = description; else delete wireStep.description;
    if (priority) wireStep.priority = priority; else delete wireStep.priority;
    if (rejection_branch_to !== undefined) wireStep.rejection_branch_to = rejection_branch_to;
    else delete wireStep.rejection_branch_to;

    wireSteps.push(wireStep as ChainDefinition["steps"][number]);
  });

  // Spread the envelope stash FIRST so chain-level axes the editor exposes no
  // control for (name, description, metadata, parallel_groups, extensions, and
  // anything a later edition adds) survive the save, then apply the defaults
  // only where nothing was loaded. version / mode / rejection_policy are the
  // envelope's policy fields: a chain saved as mode "parallel" must not come
  // back "sequential" because this editor renders no mode control.
  //
  // `steps` is overwritten unconditionally — it is the one part of the envelope
  // this function owns and rebuilds from working state.
  // First row carrying a stash, not steps[0] — a row added at the top of the
  // list is fresh and has none, and reading only index 0 would lose the
  // envelope exactly when the operator inserts a step before the seeded ones.
  const envelope = steps.find((s) => s._definitionRaw)?._definitionRaw ?? {};
  const config = {
    version: "1.0",
    mode: "sequential",
    rejection_policy: "terminate",
    ...envelope,
    steps: wireSteps,
  } as ChainDefinition;
  return { config, errors };
}

// Move step at index `from` to index `to` (both 0-based). After moving, any
// step's 1-based rejection_branch_to that pointed at a step that changed
// position is remapped to the new 1-based position.
//
// Returns the SAME array reference on a no-op (from === to or either index is
// out of range) so React can bail the re-render via referential equality.
export function moveStep(steps: WorkingStep[], from: number, to: number): WorkingStep[] {
  if (
    from === to ||
    from < 0 || from >= steps.length ||
    to < 0 || to >= steps.length
  ) {
    return steps;
  }

  // Build old-index → new-index map for all positions.
  const newPosOf = new Array<number>(steps.length);
  for (let i = 0; i < steps.length; i++) {
    if (i === from) {
      newPosOf[i] = to;
    } else if (from < to) {
      // Steps in (from, to] shift left by one.
      newPosOf[i] = i > from && i <= to ? i - 1 : i;
    } else {
      // from > to: Steps in [to, from) shift right by one.
      newPosOf[i] = i >= to && i < from ? i + 1 : i;
    }
  }

  // Build the reordered array.
  const newSteps = new Array<WorkingStep>(steps.length);
  for (let i = 0; i < steps.length; i++) {
    newSteps[newPosOf[i]] = steps[i];
  }

  // Remap rejection_branch_to (1-based) according to new positions.
  return newSteps.map((s) => {
    if (s.rejectionBranchTo == null) return s;
    const oldIdx = s.rejectionBranchTo - 1; // convert to 0-based
    if (oldIdx < 0 || oldIdx >= steps.length) return s;
    const newBranchTo = newPosOf[oldIdx] + 1; // back to 1-based
    if (newBranchTo === s.rejectionBranchTo) return s;
    return { ...s, rejectionBranchTo: newBranchTo };
  });
}

// Translate server-side zod issues into the same per-row error map the inline
// build emits, so the row component can render server errors the same way it
// renders client-side errors.
//
// Server paths arrive in two shapes:
//   * From validate.ts middleware: dotted strings like
//     "body.chain_config.steps.1.rejection_branch_to" — fed via ApiError.details
//   * From in-process zod calls: string|number arrays like
//     ["chain_config", "steps", 1, "rejection_branch_to"]
// The helper accepts either; numeric segments in dotted strings are parsed back
// to numbers so the steps-index lookup stays type-safe.
export interface ServerIssue {
  path: string | (string | number)[];
  message: string;
}

const FIELD_PATH_TO_FORM_KEY: Record<string, string> = {
  id: "stepId",
  rejection_branch_to: "rejectionBranchTo",
  rejection_policy: "rejectionPolicy",
};

function parsePathSegment(seg: string): string | number {
  if (/^\d+$/.test(seg)) return Number(seg);
  return seg;
}

function normalizePath(p: ServerIssue["path"]): (string | number)[] {
  if (typeof p === "string") return p.split(".").map(parsePathSegment);
  return p;
}

export function mapServerErrors(issues: ServerIssue[]): ValidationErrors {
  const out: ValidationErrors = {};
  for (const issue of issues) {
    const path = normalizePath(issue.path);
    const stepsIdx = path.indexOf("steps");
    if (stepsIdx === -1) continue;
    const rowRaw = path[stepsIdx + 1];
    if (typeof rowRaw !== "number") continue;
    const fieldRaw = path[stepsIdx + 2];
    let formKey: string | undefined;
    if (typeof fieldRaw === "string") {
      formKey = FIELD_PATH_TO_FORM_KEY[fieldRaw] ?? fieldRaw;
    }
    const key = formKey ? `${rowRaw}.${formKey}` : `${rowRaw}._row`;
    out[key] = issue.message;
  }
  return out;
}
