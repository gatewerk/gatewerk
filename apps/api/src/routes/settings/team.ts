import { Router } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import crypto from "node:crypto";
import { reviewers, inviteTokens, reviews } from "@gatewerk/db/src/schema/index";
import {
  generateId,
  envelope,
  listEnvelope,
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  TeamInviteBodySchema,
  TeamUpdateBodySchema,
  ITERATION_STATUSES,
} from "@gatewerk/shared";
import { config } from "../../config";
import { requireRole } from "../../middleware/require-role";
import { validate } from "../../middleware/validate";
import type { SettingsRouteDeps } from "./_deps";

export function createSettingsTeamRoutes(deps: SettingsRouteDeps): Router {
  const router = Router();
  const { db } = deps;

  // GET /api/v1/settings/team — any authenticated user. Reviewers consume
  // this list as the recipient picker in ShareViaLinkDialog (account-tier
  // tokens). Sensitive operational fields (last_login_at, created_at) are
  // redacted for non-admin callers — admins see the full record for the
  // team management UI.
  router.get("/team", async (req, res, next) => {
    try {
      const callerRole = (req as any).reviewer?.role;
      const isAdmin = callerRole === "admin" || callerRole === "owner";

      const members = await db
        .select({
          id: reviewers.id,
          email: reviewers.email,
          name: reviewers.name,
          role: reviewers.role,
          is_active: reviewers.is_active,
          last_login_at: reviewers.last_login_at,
          created_at: reviewers.created_at,
        })
        .from(reviewers);

      const projection = isAdmin
        ? members
        : members.map((m) => ({
            id: m.id,
            email: m.email,
            name: m.name,
            role: m.role,
            is_active: m.is_active,
            last_login_at: null,
            created_at: m.created_at,
          }));

      res.json(listEnvelope("reviewer", projection, { has_more: false, total: projection.length }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/settings/team/invite — generate invite token
  router.post("/team/invite", requireRole("admin"), validate({ body: TeamInviteBodySchema }), async (req, res, next) => {
    try {
      const { email, role } = req.body;
      const admin = (req as any).reviewer;

      if (!email) {
        throw new InvalidRequestError("Missing required field: email", undefined, "missing_required_fields");
      }

      // Check for duplicate email in existing users
      const [existing] = await db
        .select({ id: reviewers.id })
        .from(reviewers)
        .where(eq(reviewers.email, email))
        .limit(1);

      if (existing) {
        throw new ConflictError("A user with this email already exists", "duplicate_email");
      }

      // Generate token: 32 random bytes → 64 hex chars
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      const [invite] = await db
        .insert(inviteTokens)
        .values({
          id: generateId("invite"),
          token_hash: tokenHash,
          email,
          role: role || "reviewer",
          invited_by: admin.id,
          expires_at: expiresAt,
        })
        .returning();

      const inviteUrl = `${config.uiOrigin}/invite/${rawToken}`;

      deps.auditService?.log({
        action: "team.invited",
        actor: `reviewer:${admin.email}`,
        resource_type: "invite",
        resource_id: invite.id,
        details: { invitee_email: email, invitee_role: invite.role, ip: req.ip },
      }).catch(() => {});

      // The raw token lives only in `invite_url` — emitting it as a
      // separate `token` field needlessly widens the exposure surface
      // (proxy logs, browser devtools, accidental audit-payload inclusion).
      res.status(201).json({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expires_at: invite.expires_at,
        invite_url: inviteUrl,
      });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/v1/settings/team/:id — update reviewer. Admin only.
  //
  // Self-edit guard: admins cannot mutate their own record via this route.
  // The UI already hides the row menu for the current user, but the API
  // needs a matching guard so an admin can't promote themselves to owner
  // or deactivate themselves via curl. /auth/me handles self profile edits.
  //
  // Last-admin TOCTOU: count + UPDATE are wrapped in a transaction with
  // SELECT FOR UPDATE on the target row, so two concurrent demotions of
  // the only admin serialize behind the lock — whichever lands second
  // sees adminCount <= 1 and is rejected.
  router.put("/team/:id", requireRole("admin"), validate({ body: TeamUpdateBodySchema }), async (req, res, next) => {
    try {
      const { name, role, is_active } = req.body;
      const callerId = (req as any).reviewer?.id;
      const targetId = String(req.params.id);

      if (callerId === targetId) {
        throw new ForbiddenError(
          "Cannot edit your own account via the team management API. Use the profile settings.",
          "cannot_edit_self",
        );
      }

      const result = await db.transaction(async (tx) => {
        const [target] = await tx
          .select({ role: reviewers.role, is_active: reviewers.is_active })
          .from(reviewers)
          .where(eq(reviewers.id, targetId))
          .for("update")
          .limit(1);

        if (!target) {
          throw new NotFoundError("Reviewer not found", "reviewer_not_found");
        }

        // Last-admin protection: count active admins inside the same tx as
        // the UPDATE. The lock on the target row guarantees no other tx can
        // flip this same row between count and write; admin demotions on
        // OTHER rows serialize on their own locks, and the count then sees
        // their committed state.
        if (target.role === "admin" && target.is_active) {
          const isDemoting = role !== undefined && role !== "admin";
          const isDeactivating = is_active === false;

          if (isDemoting || isDeactivating) {
            const [{ count: adminCount }] = await tx
              .select({ count: sql<number>`cast(count(*) as int)` })
              .from(reviewers)
              .where(and(eq(reviewers.role, "admin"), eq(reviewers.is_active, true)));

            if (adminCount <= 1) {
              throw new ForbiddenError(
                "Cannot remove or demote the last admin. Promote another user first.",
                "last_admin",
              );
            }
          }
        }

        const updates: Record<string, any> = { updated_at: new Date() };
        if (name !== undefined) updates.name = name;
        if (role !== undefined) updates.role = role;
        if (is_active !== undefined) updates.is_active = is_active;

        const [updated] = await tx
          .update(reviewers)
          .set(updates)
          .where(eq(reviewers.id, targetId))
          .returning();
        return updated;
      });

      if (!result) {
        throw new NotFoundError("Reviewer not found", "reviewer_not_found");
      }

      // Audit log: surface team mutations so admin-side privilege changes
      // are reconstructible from history alongside HMAC rotates etc.
      deps.auditService?.log({
        action: "team.updated",
        actor: `reviewer:${(req as any).reviewer?.email}`,
        resource_type: "reviewer",
        resource_id: result.id,
        details: {
          changed: { name, role, is_active },
          ip: req.ip,
        },
      }).catch(() => {});

      res.json(envelope("reviewer", {
        id: result.id,
        email: result.email,
        name: result.name,
        role: result.role,
        is_active: result.is_active,
        last_login_at: result.last_login_at,
        created_at: result.created_at,
      }));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/v1/settings/team/:id — deactivate reviewer (soft delete).
  // Same self-edit + last-admin + TOCTOU semantics as PUT above.
  router.delete("/team/:id", requireRole("admin"), async (req, res, next) => {
    try {
      const callerId = (req as any).reviewer?.id;
      const targetId = String(req.params.id);

      if (callerId === targetId) {
        throw new ForbiddenError(
          "Cannot remove your own account via the team management API.",
          "cannot_edit_self",
        );
      }

      const target = await db.transaction(async (tx) => {
        const [t] = await tx
          .select({ role: reviewers.role, email: reviewers.email, is_active: reviewers.is_active })
          .from(reviewers)
          .where(eq(reviewers.id, targetId))
          .for("update")
          .limit(1);

        if (!t) {
          throw new NotFoundError("Reviewer not found", "reviewer_not_found");
        }

        if (t.role === "admin" && t.is_active) {
          const [{ count: adminCount }] = await tx
            .select({ count: sql<number>`cast(count(*) as int)` })
            .from(reviewers)
            .where(and(eq(reviewers.role, "admin"), eq(reviewers.is_active, true)));

          if (adminCount <= 1) {
            throw new ForbiddenError(
              "Cannot remove the last admin. Promote another user first.",
              "last_admin",
            );
          }
        }

        const [updated] = await tx
          .update(reviewers)
          .set({ is_active: false, updated_at: new Date() })
          .where(eq(reviewers.id, targetId))
          .returning();

        if (!updated) {
          throw new NotFoundError("Reviewer not found", "reviewer_not_found");
        }

        await tx
          .update(reviews)
          .set({ assignee: null })
          .where(
            and(
              eq(reviews.assignee, t.email),
              inArray(reviews.status, ["pending", ...ITERATION_STATUSES]),
            )
          );

        return t;
      });

      deps.auditService?.log({
        action: "team.removed",
        actor: `reviewer:${(req as any).reviewer?.email}`,
        resource_type: "reviewer",
        resource_id: targetId,
        details: { removed_email: target.email, ip: req.ip },
      }).catch(() => {});

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
