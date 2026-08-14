import helmet from "helmet";
import type { RequestHandler } from "express";

// The API serves JSON and user-uploaded media under /uploads. No HTML rendering,
// so the HTML-oriented CSP directives (script-src, style-src) don't protect anything.
// We keep the conservative default-src 'none' posture and explicitly allow
// cross-origin reads so the web app can load images from a different subdomain.
export function securityHeaders(): RequestHandler {
  const helmetHandler = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: {
      maxAge: 63072000,
      includeSubDomains: true,
      preload: true,
    },
    xFrameOptions: { action: "deny" },
    xContentTypeOptions: true,
  });

  return (req, res, next) => {
    helmetHandler(req, res, () => {
      res.setHeader(
        "Permissions-Policy",
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
      );
      next();
    });
  };
}
