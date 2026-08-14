import { Router } from "express";

export function createKeyInfoRoutes(): Router {
  const router = Router();

  // GET /api/v1/auth/key-info — introspect API key scopes
  router.get("/", (req: any, res) => {
    res.json({
      object: "key_info",
      scopes: req.scopes,
      prefix: req.apiKeyPrefix,
    });
  });

  return router;
}
