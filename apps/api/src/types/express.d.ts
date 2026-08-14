// Global Express namespace augmentations for Gatewerk's middleware contract.
//
// Lane E (Phase 3) consolidates the per-request fields that downstream
// handlers + middleware factories rely on. This file is the canonical
// declaration site — individual files (cloud-auth.ts, check-entitlement.ts)
// previously redeclared subsets in their own scope; those redeclarations
// are kept for the fields they introduce (subscription, entitlementCache)
// but `projectId` + `app.db` are centralised here.

import type { AppDb } from "@gatewerk/db";

declare global {
  namespace Express {
    interface Request {
      /** Set by dual-auth / api-key-auth / cloud-auth middleware after token resolution. */
      projectId?: string;
    }
    interface Application {
      /**
       * The shared Drizzle DB handle, attached during app bootstrap
       * (apps/api/src/app.ts:183). Reachable from route handlers via
       * `req.app.db` once the bootstrap step runs.
       */
      db?: AppDb;
    }
  }
}

export {};
