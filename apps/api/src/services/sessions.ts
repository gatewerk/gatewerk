import { eq, and, isNull, isNotNull, gt, lt, or, sql, desc } from "drizzle-orm";
import crypto from "crypto";
import { sessions } from "@gatewerk/db/src/schema/index";
import { generateId } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { serverEnv } from "../env";

const SESSION_EXPIRY_DAYS = 7;
const INACTIVITY_TIMEOUT_HOURS = serverEnv.SESSION_INACTIVITY_TIMEOUT_HOURS;
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

export interface CreateSessionInput {
  reviewerId: string;
  ipAddress: string | undefined;
  userAgent: string | undefined;
}

export interface SessionRow {
  id: string;
  reviewer_id: string;
  jti: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
  last_active_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface ValidatedSession {
  sessionId: string;
  reviewerId: string;
  lastActiveAt: Date;
}

export function createSessionService(db: AppDb) {
  return {
    async create(input: CreateSessionInput): Promise<{ jti: string; sessionId: string }> {
      const jti = crypto.randomBytes(16).toString("hex");
      const id = generateId("session");
      const expiresAt = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      await db.insert(sessions).values({
        id,
        reviewer_id: input.reviewerId,
        jti,
        ip_address: input.ipAddress ?? null,
        user_agent: input.userAgent ?? null,
        expires_at: expiresAt,
      });

      return { jti, sessionId: id };
    },

    async validateByJti(jti: string): Promise<ValidatedSession | null> {
      const now = new Date();
      const inactivityCutoff = new Date(
        now.getTime() - INACTIVITY_TIMEOUT_HOURS * 60 * 60 * 1000,
      );

      const [row] = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.jti, jti),
            isNull(sessions.revoked_at),
            gt(sessions.expires_at, now),
            gt(sessions.last_active_at, inactivityCutoff),
          ),
        )
        .limit(1);

      if (!row) return null;

      return {
        sessionId: row.id,
        reviewerId: row.reviewer_id,
        lastActiveAt: row.last_active_at,
      };
    },

    async updateLastActive(sessionId: string, lastActiveAt: Date): Promise<void> {
      const elapsed = Date.now() - lastActiveAt.getTime();
      if (elapsed < LAST_ACTIVE_THROTTLE_MS) return;

      await db
        .update(sessions)
        .set({ last_active_at: new Date() })
        .where(eq(sessions.id, sessionId));
    },

    async listForReviewer(reviewerId: string): Promise<SessionRow[]> {
      return db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.reviewer_id, reviewerId),
            isNull(sessions.revoked_at),
            gt(sessions.expires_at, new Date()),
          ),
        )
        .orderBy(desc(sessions.last_active_at));
    },

    async revoke(sessionId: string, reviewerId: string): Promise<boolean> {
      const result = await db
        .update(sessions)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.reviewer_id, reviewerId),
            isNull(sessions.revoked_at),
          ),
        )
        .returning();

      return result.length > 0;
    },

    async revokeAllExcept(reviewerId: string, currentJti: string): Promise<number> {
      const result = await db
        .update(sessions)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(sessions.reviewer_id, reviewerId),
            isNull(sessions.revoked_at),
            sql`${sessions.jti} != ${currentJti}`,
          ),
        )
        .returning();

      return result.length;
    },

    async revokeAll(reviewerId: string): Promise<number> {
      const result = await db
        .update(sessions)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(sessions.reviewer_id, reviewerId),
            isNull(sessions.revoked_at),
          ),
        )
        .returning();

      return result.length;
    },

    async cleanup(): Promise<number> {
      const REVOKED_RETENTION_HOURS = 48;
      const EXPIRED_RETENTION_DAYS = 30;
      const revokedCutoff = new Date(Date.now() - REVOKED_RETENTION_HOURS * 60 * 60 * 1000);
      const expiredCutoff = new Date(Date.now() - EXPIRED_RETENTION_DAYS * 24 * 60 * 60 * 1000);

      const result = await db
        .delete(sessions)
        .where(or(
          and(isNotNull(sessions.revoked_at), lt(sessions.revoked_at, revokedCutoff)),
          and(isNull(sessions.revoked_at), lt(sessions.expires_at, expiredCutoff)),
        ))
        .returning();

      return result.length;
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
