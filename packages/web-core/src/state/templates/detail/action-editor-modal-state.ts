// Pure-logic state helpers extracted from ActionEditorModal.tsx for size-cap
// compliance. Mirrors the chain-editor-state.ts precedent: every transformation
// the modal performs between its FormState and the canonical
// TemplateActionConfigCanonical wire shape lives here, so the component file
// stays focused on JSX + lifecycle.
//
// All exports are intentionally framework-free — no React, no DOM — so they
// can be exercised by vitest without rendering.
//
// SURFACE TIERING. The declaration
// (packages/shared/src/surface-tiers/templates.ts, ACTION_AXES) ships four core
// action axes: id · label · kind · decision_value. The other eight are roadmap
// tier: reachable over the API, absent from the editor. The four are drawn as
// TWO visible controls — a Label and a Role — because kind and decision_value
// only ever move together in practice.
//
// The ruling is HIDE, NEVER DELETE, so the eight unrendered axes ride through
// `preserved` untouched. Anything moved out of FORM_OWNED_KEYS_ARRAY without a
// matching PreservedKey entry stops round tripping and silently deletes an
// operator's API-set value; draft-config-preservation.test.ts is the gate.

import {
  TemplateActionConfigSchema,
  type TemplateActionConfigCanonical,
  type DecisionValue,
  type ActionKind,
} from "@gatewerk/shared";

export type ActionStyle = NonNullable<TemplateActionConfigCanonical["style"]>;
export type Mode = "preset-picker" | "form";
export type PresetKey = "approve" | "reject" | "request_changes" | "custom";

// One picker carrying kind + decision_value together. Each role is a point in
// the (outcome, custody) space described in the action-architecture design:
//   approve   → outcome approved,  custody nobody
//   reject    → outcome rejected,  custody nobody
//   send_back → outcome none,      custody the agent
//   notify    → outcome none,      custody unchanged
//
// ⚠️ The fourth role is "Notify", NOT "Other". "Other" invites an author to
// write "Send it to legal", which compiles to a side_effect that fires a webhook
// and moves nothing — a button that claims to route and does not. Custody to a
// person is a real capability and it is held for after launch; until it exists,
// this label must not imply it.
export const ACTION_ROLES = ["approve", "reject", "send_back", "notify"] as const;
export type ActionRole = typeof ACTION_ROLES[number];

export const ROLE_LABELS: Record<ActionRole, string> = {
  approve: "Approve",
  reject: "Reject",
  send_back: "Send back",
  notify: "Notify",
};

const ROLE_KIND: Record<ActionRole, ActionKind> = {
  approve: "decision",
  reject: "decision",
  send_back: "iteration",
  notify: "side_effect",
};

const ROLE_DECISION_VALUE: Record<ActionRole, DecisionValue | undefined> = {
  approve: "approved",
  reject: "rejected",
  send_back: undefined,
  notify: undefined,
};

// The style a role implies on its own. Approve renders primary, reject
// renders destructive, everything else carries no style and falls back to the
// inbox default.
//
// `style` was DERIVED and nothing else —
// "a knob that disappears with nothing lost". What was lost is
// now known: a send-back or a notify that genuinely destroys something could
// not be made red, while the inbox rail, the external review page and both
// apps/web surfaces have honoured `style: "destructive"` the whole time. The
// derivation stays for the two roles that carry their own colour; the other
// two get one bit, and only that bit — see `roleOwnsDestructive`.
const ROLE_STYLE: Record<ActionRole, ActionStyle | undefined> = {
  approve: "primary",
  reject: "destructive",
  send_back: undefined,
  notify: undefined,
};

export function roleOf(
  action: Pick<TemplateActionConfigCanonical, "kind" | "decision_value">,
): ActionRole {
  if (action.kind === "iteration") return "send_back";
  if (action.kind !== "decision") return "notify";
  return action.decision_value === "rejected" ? "reject" : "approve";
}

export function kindForRole(role: ActionRole): ActionKind {
  return ROLE_KIND[role];
}

export function decisionValueForRole(role: ActionRole): DecisionValue | undefined {
  return ROLE_DECISION_VALUE[role];
}

// Auto-slug, mirroring `nameToId` in chain-editor-state.ts. The server's action
// id rule is lowercase letters, digits and underscores only (no hyphen, unlike
// a template slug) — packages/shared/src/api/schemas/templates.ts,
// TemplateActionConfigSchema.id. The input maxLength is 40, so the slug is cut
// to match rather than to the chain editor's 64.
export function labelToActionId(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

// Applied on every keystroke in the ID field, so it must not eat characters the
// operator is mid-way through typing — it strips, it does not collapse.
export function sanitizeActionId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

// `style` is derived, but an operator can still have set one over the API on an
// axis the editor no longer renders. Re-derive only when the stored style is
// the one this role would have produced anyway (so a role change moves it);
// otherwise leave the operator's value alone.
export function resolveStyle(
  previousRole: ActionRole | undefined,
  nextRole: ActionRole,
  existing: ActionStyle | undefined,
): ActionStyle | undefined {
  if (existing === undefined) return ROLE_STYLE[nextRole];
  if (previousRole !== undefined && existing === ROLE_STYLE[previousRole]) {
    return ROLE_STYLE[nextRole];
  }
  return existing;
}

/**
 * Whether the destructive bit is the operator's to set for this role.
 *
 * Approve and reject already ARE their colour: an approve that renders red or
 * a reject that renders green is not a configuration, it is a contradiction.
 * So the editor draws no control on them and the bit is neither read nor
 * written. Send back and notify have no implied colour at all, and they are
 * the roles a genuinely destructive custom action has to land on.
 */
export function roleOwnsDestructive(role: ActionRole | ""): boolean {
  return role === "send_back" || role === "notify";
}

/**
 * The one bit of `style` the editor authors, resolved against whatever was
 * already stored.
 *
 * Everything the control cannot show survives it. `secondary` and `warning`
 * are reachable over the API and have no checkbox here, so they are not this
 * control's to delete — HIDE, NEVER DELETE applies to values as much as to
 * axes. What the bit does own is `destructive`: switching it off has to clear
 * one, and must not resurrect it out of the stored value on the next save.
 */
export function styleForSubmit(
  previousRole: ActionRole | undefined,
  nextRole: ActionRole,
  existing: ActionStyle | undefined,
  destructive: boolean,
): ActionStyle | undefined {
  if (!roleOwnsDestructive(nextRole)) return resolveStyle(previousRole, nextRole, existing);
  if (destructive) return "destructive";
  if (existing === "destructive") return ROLE_STYLE[nextRole];
  return resolveStyle(previousRole, nextRole, existing);
}

export interface FormState {
  id: string;
  label: string;
  role: ActionRole | "";
  /** Only meaningful where `roleOwnsDestructive(role)`. */
  destructive: boolean;
}

export const EMPTY_FORM: FormState = {
  id: "",
  label: "",
  role: "",
  destructive: false,
};

export type FormErrors = Partial<Record<keyof FormState | "_form", string>>;

// Source-of-truth array for the FormState-owned canonical keys. The
// `satisfies ReadonlyArray<keyof TemplateActionConfigCanonical>` clause makes
// this list checked at compile time against the shared canonical type — typos
// or removed canonical fields fail to type-check. `role` is not listed: it is a
// UI-only collapse of `kind` + `decision_value`, both of which are.
const FORM_OWNED_KEYS_ARRAY = [
  "id",
  "label",
  "kind",
  "decision_value",
] as const satisfies ReadonlyArray<keyof TemplateActionConfigCanonical>;

type FormOwnedKey = typeof FORM_OWNED_KEYS_ARRAY[number];

export const FORM_OWNED_KEYS: ReadonlySet<FormOwnedKey> = new Set(FORM_OWNED_KEYS_ARRAY);

// Fields not in FormState that we explicitly want to round-trip via
// `preserved`. Adding a new optional field to TemplateActionConfigCanonical
// without classifying it here will cause _CoverageCheck below to fail at
// compile time, forcing the maintainer to choose: form-owned (update FormState
// + FORM_OWNED_KEYS_ARRAY) or preserved (extend PreservedKey).
//
// The five at the end are the controls the surface-tiering removal took off the
// screen. They are roadmap tier, not deleted — every one of them has to survive
// an operator opening an action and renaming it.
type PreservedKey =
  | "description"
  | "icon"
  | "order"
  | "enabled_for_status"
  | "style"
  | "webhook_event"
  | "requires_feedback"
  | "confirmation"
  | "expose_to_recipient";

type _UnclassifiedCanonicalKeys = Exclude<
  keyof TemplateActionConfigCanonical,
  FormOwnedKey | PreservedKey
>;
type _CoverageCheck = _UnclassifiedCanonicalKeys extends never ? true : false;
// Reference the assertion to keep ts-check active without an unused-var
// warning. Exporting as a type alias means it shows up in the module surface
// and its value is checked at compile time — if a new canonical key is added
// without classification, _CoverageCheck resolves to `false` and this type
// aliases `false`, which is fine on its own but the upstream
// _UnclassifiedCanonicalKeys type forces a maintainer-visible failure if any
// downstream code ever tries to use it.
export type _ASSERT_FORMSTATE_MIRRORS_CANONICAL = _CoverageCheck;

export function extractPreserved(
  action: TemplateActionConfigCanonical,
): Partial<TemplateActionConfigCanonical> {
  const out: Partial<TemplateActionConfigCanonical> = {};
  for (const k of Object.keys(action) as Array<keyof TemplateActionConfigCanonical>) {
    if (!FORM_OWNED_KEYS.has(k as FormOwnedKey)) {
      (out as Record<string, unknown>)[k] = action[k];
    }
  }
  return out;
}

export function canonicalToFormState(action: TemplateActionConfigCanonical): FormState {
  const role = roleOf(action);
  return {
    id: action.id,
    label: action.label,
    role,
    // Seeded false on approve and reject even when the stored style says
    // otherwise. Their control is not drawn, so a true here would survive a
    // later role change and carry a colour the operator never asked for onto
    // a role that does not imply it.
    destructive: roleOwnsDestructive(role) && action.style === "destructive",
  };
}

export function buildCanonical(
  form: FormState,
  preserved: Partial<TemplateActionConfigCanonical>,
  previousRole?: ActionRole,
): TemplateActionConfigCanonical | null {
  if (form.role === "") return null;
  const kind = ROLE_KIND[form.role];
  const out: TemplateActionConfigCanonical = {
    ...preserved,
    id: form.id,
    label: form.label,
    kind,
  };

  const decisionValue = ROLE_DECISION_VALUE[form.role];
  if (decisionValue) out.decision_value = decisionValue;
  else delete out.decision_value;

  // The schema forbids webhook_event on kind=decision (events are auto-derived),
  // so a preserved one from a former side-effect action cannot ride along.
  if (kind === "decision") delete out.webhook_event;

  const style = styleForSubmit(previousRole, form.role, preserved.style, form.destructive);
  if (style) out.style = style;
  else delete out.style;

  return out;
}

// The server rule is "at most one action per decision_value". The editor draws
// it as an affordance rather than a 422: taking a role another action holds
// demotes that action to Other, which is what the Detail Redesign prototype
// does with its primary-verdict exclusivity.
export function demoteAction(
  action: TemplateActionConfigCanonical,
): TemplateActionConfigCanonical {
  const previousRole = roleOf(action);
  const out: TemplateActionConfigCanonical = { ...action, kind: ROLE_KIND.notify };
  delete out.decision_value;
  const style = resolveStyle(previousRole, "notify", action.style);
  if (style) out.style = style;
  else delete out.style;
  return out;
}

// Upserts the modal's result into the action list and demotes whoever else held
// the role. `editIndex` is null for an add.
export function applySubmittedAction(
  actions: readonly TemplateActionConfigCanonical[],
  submitted: TemplateActionConfigCanonical,
  editIndex: number | null,
): TemplateActionConfigCanonical[] {
  const next =
    editIndex === null
      ? [...actions, submitted]
      : actions.map((a, i) => (i === editIndex ? submitted : a));
  if (!submitted.decision_value) return next;
  const submittedIndex = editIndex === null ? next.length - 1 : editIndex;
  return next.map((a, i) => {
    if (i === submittedIndex) return a;
    if (a.decision_value !== submitted.decision_value) return a;
    return demoteAction(a);
  });
}

export interface ValidateContext {
  isEdit: boolean;
  initialId: string | undefined;
  existingIds: readonly string[];
  previousRole: ActionRole | undefined;
}

export function validate(
  form: FormState,
  preserved: Partial<TemplateActionConfigCanonical>,
  ctx: ValidateContext,
):
  | { ok: true; value: TemplateActionConfigCanonical }
  | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  if (!form.id) errors.id = "Required";
  else if (!/^[a-z0-9_]+$/.test(form.id)) errors.id = "Lowercase letters, digits, underscores only";
  if (!form.label.trim()) errors.label = "Required";
  if (form.role === "") errors.role = "Required";

  if (form.id) {
    const conflictsWithOther = ctx.existingIds.some((id) => id === form.id && (!ctx.isEdit || id !== ctx.initialId));
    if (conflictsWithOther) errors.id = "Action ID already in use";
  }

  // No duplicate-decision_value error any more: taking a held role demotes the
  // holder (see applySubmittedAction), so there is nothing for the operator to
  // fix here.

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const candidate = buildCanonical(form, preserved, ctx.previousRole);
  if (!candidate) return { ok: false, errors: { role: "Required" } };

  const parsed = TemplateActionConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors: FormErrors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof FormState | undefined;
      if (key && key in EMPTY_FORM && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      } else {
        fieldErrors._form = fieldErrors._form
          ? `${fieldErrors._form}; ${issue.message}`
          : issue.message;
      }
    }
    return { ok: false, errors: fieldErrors };
  }
  return { ok: true, value: parsed.data };
}

export const allTouched: Record<keyof FormState, boolean> = {
  id: true,
  label: true,
  role: true,
  destructive: true,
};
