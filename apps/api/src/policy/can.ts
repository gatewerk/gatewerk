import type { Scope } from "@gatewerk/shared";
import { ROLE_SCOPES, type Role } from "./roles";
import type {
  ApiKeySubject,
  ChainStepSubject,
  SessionSubject,
  Subject,
} from "./subjects";

// bypass is set when the decision was granted via an admin or owner route
// rather than via direct assignee match. Consumers (assertChainStepAllows)
// use it to fire a chain.admin_bypass audit entry for observability.
export type Decision = { allow: true; bypass?: "admin" | "owner" } | { allow: false; reason: string };

export function can(subject: Subject, required: Scope[]): Decision {
  switch (subject.kind) {
    case "api_key":
      return canApiKey(subject, required);
    case "session":
      return canSession(subject, required);
    case "chain_step": {
      // Chain-step gating is the load-bearing addition in M11: only
      // participants named on the step (or the chain owner, or an admin)
      // can operate on a chain-attached review. Scope still applies via
      // the inner requester — compound success requires both.
      const gate = evaluateChainStep(subject);
      if (!gate.allow) return gate;
      const scopeDecision = can(subject.requester, required);
      if (!scopeDecision.allow) return scopeDecision;
      // Thread bypass from the gate into the final allow so callers
      // (assertChainStepAllows) can observe how the gate was cleared.
      return { allow: true, bypass: gate.bypass };
    }
  }
}

function canApiKey(subject: ApiKeySubject, required: Scope[]): Decision {
  const missing = required.filter((s) => !subject.scopes.includes(s));
  return missing.length === 0
    ? { allow: true }
    : { allow: false, reason: `missing-scope:${missing.join(",")}` };
}

function canSession(subject: SessionSubject, required: Scope[]): Decision {
  const granted = ROLE_SCOPES[subject.role as Role];
  if (!granted) return { allow: false, reason: `unknown-role:${subject.role}` };
  const missing = required.filter((s) => !granted.includes(s));
  return missing.length === 0
    ? { allow: true }
    : { allow: false, reason: `role-lacks-scope:${subject.role}:${missing.join(",")}` };
}

// Chain-step gate. Allow iff:
//   (a) requester is a session with role=admin, OR
//   (b) requester is the chain owner (userId match, or "reviewer:<email>"
//       prefix match for chains created via routes/chains.ts format), OR
//   (c) requester matches step_assignee (email for email-kind, role for
//       role-kind).
// api_key requesters fail by construction — they carry no email/role and
// are not a session-scoped "admin". Chains are human-approval flows.
//
// bypass? on the allow result: "admin" for path (a), "owner" for path (b),
// absent for path (c). Consumed by assertChainStepAllows to fire the
// chain.admin_bypass audit event so ops can distinguish privileged access
// from ordinary assignee-matched access.
function evaluateChainStep(subject: ChainStepSubject): Decision {
  const { requester, step_assignee, chain_owner_id } = subject;

  if (requester.kind === "session") {
    if (requester.role === "admin") return { allow: true, bypass: "admin" };
    if (isChainOwner(requester, chain_owner_id)) return { allow: true, bypass: "owner" };
    if (step_assignee) {
      if (step_assignee.kind === "email"
          && requester.email
          && requester.email === step_assignee.email) {
        return { allow: true };
      }
      if (step_assignee.kind === "role"
          && requester.role === step_assignee.role) {
        return { allow: true };
      }
    }
  }

  return {
    allow: false,
    reason: `chain-step:requester-not-allowed:${subject.chain_run_id}:step-${subject.step_index}`,
  };
}

// The privileged-viewer check for chain-run PII scrubbing. Not a can() arm:
// it gates response shaping (kind-only vs full assignee specs on pending
// steps), not access. Privileged = admin session OR chain owner (session).
// API-key callers are never privileged.
export function isPrivilegedChainViewer(req: any, chainOwnerId: string): boolean {
  if (req.authType !== "session") return false;
  const reviewer = req.reviewer;
  if (reviewer?.role === "admin") return true;
  // `?? ""`: req.userId may be absent; the routes' inline closures guarded
  // with `userId && userId === owner`, and "" can never equal a real
  // created_by value.
  return isChainOwner(
    { kind: "session", userId: req.userId ?? "", role: reviewer?.role ?? "", email: reviewer?.email },
    chainOwnerId,
  );
}

function isChainOwner(requester: SessionSubject, chain_owner_id: string): boolean {
  if (requester.userId === chain_owner_id) return true;
  if (requester.email && `reviewer:${requester.email}` === chain_owner_id) return true;
  if (requester.email && requester.email === chain_owner_id) return true;
  return false;
}
