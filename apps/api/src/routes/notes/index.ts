import { Router } from "express";
import type { AppDb } from "@gatewerk/db";
import type { createAuditService } from "../../services/audit";
import { createNotesWriteRoutes } from "./write";
import { createNotesReadRoutes } from "./read";
import { createNotesAttachmentRoutes } from "./attachments";
import { createNotesTagRoutes } from "./tags";

// Mount order is load-bearing: Express matches first-registered-wins.
// - tags first: literal /tags path beats /:id wildcard.
// - attachments second: /:id/attachments is more specific than /:id.
// - write third + read last: both share /:id; write owns the mutation
//   verbs (POST / + PATCH/DELETE /:id) while read owns GET / + GET /:id.
export function createNotesRoutes(
  db: AppDb,
  auditService: ReturnType<typeof createAuditService>,
): Router {
  const router = Router();
  const deps = { db, auditService };
  router.use(createNotesTagRoutes(deps));
  router.use(createNotesAttachmentRoutes(deps));
  router.use(createNotesWriteRoutes(deps));
  router.use(createNotesReadRoutes(deps));
  return router;
}
