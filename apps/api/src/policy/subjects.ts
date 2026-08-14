import type { Scope } from "@gatewerk/shared";

// Chain-step assignee shape. Derived from ChainDefinitionStep.assignee by
// buildChainStepSubject (policy/chain-subject.ts): `user` kind with an email
// collapses to `email`; `role` stays `role`; `external_token` collapses to
// `null` because tokens do not identify a session/api_key requester against
// which to match — the /r/:token surface authenticates them separately.
export type ChainStepAssignee =
  | { kind: "email"; email: string }
  | { kind: "role"; role: string };

// Base subjects carry the requester's identity. They are what
// subjectFromRequest() returns and what existing can() arms match on.
export type ApiKeySubject = {
  kind: "api_key";
  projectId: string;
  scopes: Scope[];
};

export type SessionSubject = {
  kind: "session";
  userId: string;
  role: string;
  // `email` is populated by subjectFromRequest from req.reviewer.email, which
  // validateJwt always returns. It stays optional on the type so pure unit
  // tests can construct sessions without it; chain-step gating (policy/can.ts)
  // treats an absent email as "cannot match email-assignee".
  email?: string;
};

// Chain-step subject composes the chain context with the requester identity.
// The `requester` field is intentionally narrowed to base subjects to forbid
// recursive chain_step-in-chain_step construction; this mirrors the way
// chain-aware checks only wrap once around an existing auth context.
export type ChainStepSubject = {
  kind: "chain_step";
  review_id: string;
  chain_run_id: string;
  step_index: number;
  step_assignee: ChainStepAssignee | null;
  chain_owner_id: string;
  requester: ApiKeySubject | SessionSubject;
};

export type Subject = ApiKeySubject | SessionSubject | ChainStepSubject;

// The admin predicates below are THE definition of "admin" for inline route
// checks — routes that used to spell `req.reviewer?.role === "admin"` or
// `subject.role === "admin"` by hand call these instead, so the predicate
// cannot drift per-file. Both are session-only by construction: api_key
// requesters carry no role and are never admin.
export function isAdminSession(req: any): boolean {
  return req.authType === "session" && req.reviewer?.role === "admin";
}

export function isAdminSubject(subject: Subject): boolean {
  return subject.kind === "session" && subject.role === "admin";
}

export function subjectFromRequest(req: any): ApiKeySubject | SessionSubject | null {
  const t = req.authType;
  if (t === "apikey") {
    return {
      kind: "api_key",
      projectId: req.projectId,
      scopes: req.scopes as Scope[],
    };
  }
  if (t === "session" && req.reviewer) {
    return {
      kind: "session",
      userId: req.reviewer.id,
      role: req.reviewer.role,
      email: req.reviewer.email,
    };
  }
  return null;
}
