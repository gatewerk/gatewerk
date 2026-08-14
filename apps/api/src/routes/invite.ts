import { Router } from "express";
import { eq } from "drizzle-orm";
import { hashPassword } from "../services/auth/password";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import rateLimit from "express-rate-limit";
import { reviewers, inviteTokens, projects } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";
import {
  generateId,
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  GoneError,
} from "@gatewerk/shared";
import { config } from "../config";
import { serverEnv } from "../env";
import { createSessionService } from "../services/sessions";
import { resolveProjectId } from "../lib/resolve-project-id";
import { validatePassword } from "../lib/password-policy";
import { isUniqueViolation } from "../lib/pg-error";
import { RateLimitError } from "../lib/http-errors";
import type { AuditService } from "../services/audit";

const isTest = serverEnv.NODE_ENV === "test" || serverEnv.VITEST === "true";

const inviteAcceptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: new RateLimitError("Too many invite attempts. Try again in 15 minutes.").toJSON(),
});

export function createInviteRoutes(
  db: AppDb,
  auditService?: AuditService,
): Router {
  const router = Router();
  const sessionService = createSessionService(db);

  // GET /api/v1/auth/invite/:token — validate invite token (public)
  router.get("/:token", async (req, res, next) => {
    try {
      const rawToken = String(req.params.token);
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

      const [invite] = await db
        .select()
        .from(inviteTokens)
        .where(eq(inviteTokens.token_hash, tokenHash))
        .limit(1);

      if (!invite) {
        throw new NotFoundError("Invalid invite link", "invite_invalid");
      }

      if (invite.used_at) {
        throw new GoneError("This invite has already been used", "invite_used");
      }

      if (new Date(invite.expires_at) < new Date()) {
        throw new GoneError("This invite has expired", "invite_expired");
      }

      // The accept screen greets the invitee with who invited them and to
      // what. Both fields are gated behind the validity checks above — an
      // invalid/used/expired token learns nothing. invite_tokens carries no
      // tenant scope (see the accept handler's audit note), so team_name uses
      // the same oldest-project fallback as the rest of the app
      // (resolveProjectId); if cloud multi-seat ever scopes invites to a
      // tenant, this join must follow that scoping.
      const [inviter] = await db
        .select({ name: reviewers.name })
        .from(reviewers)
        .where(eq(reviewers.id, invite.invited_by))
        .limit(1);

      const projectId = await resolveProjectId(req, db);
      let teamName: string | null = null;
      if (projectId) {
        const [project] = await db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        teamName = project?.name ?? null;
      }

      res.json({
        email: invite.email,
        role: invite.role,
        inviter_name: inviter?.name ?? null,
        team_name: teamName,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/auth/invite/:token — accept invite (public)
  router.post("/:token", inviteAcceptLimiter, async (req, res, next) => {
    try {
      const rawToken = String(req.params.token);
      const { name, password } = req.body;

      if (typeof name !== "string" || typeof password !== "string" || !name || !password) {
        throw new InvalidRequestError("Missing required fields: name, password", undefined, "missing_required_fields");
      }

      const invPolicyResult = await validatePassword(password);
      if (!invPolicyResult.valid) {
        throw new InvalidRequestError(
          invPolicyResult.message ?? "Password does not meet policy requirements",
          "password",
          invPolicyResult.code ?? "password_policy",
        );
      }

      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

      const [invite] = await db
        .select()
        .from(inviteTokens)
        .where(eq(inviteTokens.token_hash, tokenHash))
        .limit(1);

      if (!invite) {
        throw new NotFoundError("Invalid invite link", "invite_invalid");
      }

      if (invite.used_at) {
        throw new GoneError("This invite has already been used", "invite_used");
      }

      if (new Date(invite.expires_at) < new Date()) {
        throw new GoneError("This invite has expired", "invite_expired");
      }

      const [existing] = await db
        .select({ id: reviewers.id })
        .from(reviewers)
        .where(eq(reviewers.email, invite.email))
        .limit(1);

      if (existing) {
        throw new ConflictError("An account with this email already exists", "email_taken");
      }

      const password_hash = await hashPassword(password);

      let reviewer: typeof reviewers.$inferSelect;
      try {
        [reviewer] = await db
          .insert(reviewers)
          .values({
            id: generateId("user"),
            name: name.trim(),
            email: invite.email,
            password_hash,
            role: invite.role,
          })
          .returning();
      } catch (err) {
        // The SELECT above already checked for an existing account by email;
        // this only closes the TOCTOU race window between that check and this
        // insert (two invite-accept requests for the same email racing each
        // other). Read through drizzle's DrizzleQueryError wrapper — see
        // lib/pg-error.ts. Deliberately unnamed: this constraint has two live
        // names depending on how the DB was provisioned — Postgres
        // auto-generates `reviewers_email_key` from the unnamed inline UNIQUE
        // on an incrementally-migrated install, while a fresh install
        // bootstrapped from packages/db/scripts/baseline.sql gets the
        // drizzle-declared `reviewers_email_unique`. reviewers' only other
        // unique column (supabase_user_id) is nullable and never set by this
        // insert, so an unnamed 23505 here is unambiguous. Honest caveat: the
        // PK (id) is also unique, and generateId("user") is not proven
        // collision-free — a colliding id here would be misclassified as an
        // email conflict rather than a PK collision. Astronomically unlikely,
        // not handled separately.
        if (isUniqueViolation(err)) {
          throw new ConflictError("An account with this email already exists", "email_taken");
        }
        throw err;
      }

      await db
        .update(inviteTokens)
        .set({ used_at: new Date() })
        .where(eq(inviteTokens.id, invite.id));

      const { jti } = await sessionService.create({
        reviewerId: reviewer.id,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] as string | undefined,
      });

      const token = jwt.sign(
        { sub: reviewer.id, email: reviewer.email, role: reviewer.role, tokenVersion: reviewer.token_version ?? 0, jti },
        config.jwtSecret,
        { expiresIn: "7d", audience: "gatewerk-dashboard", issuer: "gatewerk-api" },
      );

      // Tier 2 REQUIRED (services/AUDIT-WRITE-CONTRACT.md). This is where a new
      // PRINCIPAL comes into existence: a reviewer who can approve and reject
      // from this moment on, created by an unauthenticated public request whose
      // only credential is the invite token. `team.invited` records that an
      // invite was ISSUED; nothing recorded that it was consumed, so the chain
      // could not say when a decision-capable account began to exist, nor tie it
      // back to the admin who authorised it.
      //
      // No project_id: invite_tokens and reviewers are not project-scoped, and
      // its issuance twin `team.invited` (routes/settings/team.ts) deliberately
      // omits it for the same reason. Actor is the new reviewer, since the
      // request is theirs; `invited_by` carries the authorising admin.
      // The raw token is never recorded — only the invite row's id.
      if (auditService) {
        await auditService.log({
          action: "invite.redeemed",
          actor: `reviewer:${reviewer.email}`,
          resource_type: "invite",
          resource_id: invite.id,
          details: {
            reviewer_id: reviewer.id,
            granted_role: reviewer.role,
            invited_by: invite.invited_by,
            invite_created_at: invite.created_at.toISOString(),
            ip: req.ip,
          },
        });
      }

      res.status(201).json({
        token,
        reviewer: {
          id: reviewer.id,
          email: reviewer.email,
          name: reviewer.name,
          role: reviewer.role,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
