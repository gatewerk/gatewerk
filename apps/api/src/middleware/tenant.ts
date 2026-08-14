import { Request, Response, NextFunction } from "express";
import { serverEnv } from "../env";

export type GatewerkMode = "standalone" | "cloud";

/**
 * Read GATEWERK_MODE from environment. Defaults to "standalone" (OSS).
 *
 * standalone: single organization, single project, no org UI
 * cloud: multiple organizations, multi-project, billing, org switcher
 */
export const GATEWERK_MODE: GatewerkMode = serverEnv.GATEWERK_MODE;

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      gatewerkMode: GatewerkMode;
      organizationId?: string;
    }
  }
}

/**
 * Tenant context middleware.
 *
 * Enriches every request with:
 * - req.gatewerkMode — "standalone" or "cloud"
 * - req.organizationId — resolved from auth context (cloud mode only)
 *
 * In standalone mode, organizationId is undefined — all data access uses
 * projectId which is sufficient (there's only one project/org).
 *
 * In cloud mode (future), organizationId is resolved from:
 * 1. JWT claims (dashboard users)
 * 2. API key → project → organization (agents)
 */
export function tenantContext() {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.gatewerkMode = GATEWERK_MODE;

    if (GATEWERK_MODE === "cloud") {
      // Cloud mode: resolve org from auth
      // This will be implemented when cloud launches.
      // For now, req.organizationId remains undefined.
    }

    next();
  };
}

/** Check if running in cloud mode */
export function isCloudMode(): boolean {
  return GATEWERK_MODE === "cloud";
}

/** Check if running in standalone (OSS) mode */
export function isStandaloneMode(): boolean {
  return GATEWERK_MODE === "standalone";
}
