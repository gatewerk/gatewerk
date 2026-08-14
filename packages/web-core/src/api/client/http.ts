const TOKEN_KEY = "gatewerk_token";

// Rolling server-clock offset (serverNow - clientNow) captured from response
// Date headers. Consumed by useCountdown so veto-window countdowns follow
// the server-authoritative expires_at (spec §4.9). Date headers have 1s
// resolution — good enough for an M:SS display.
let serverClockOffsetMs = 0;
export function getServerClockOffsetMs(): number {
  return serverClockOffsetMs;
}
function captureServerClock(res: Response): void {
  const dateHeader = res.headers.get("date");
  if (dateHeader) {
    const serverNow = Date.parse(dateHeader);
    if (!Number.isNaN(serverNow)) serverClockOffsetMs = serverNow - Date.now();
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string, remember = false): void {
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
  }
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

let cloudTokenGetter: (() => Promise<string | null>) | null = null;

export function setCloudTokenGetter(getter: (() => Promise<string | null>) | null): void {
  cloudTokenGetter = getter;
}

export interface ApiErrorDetail {
  path: string;
  message: string;
  code: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public requestId?: string,
    // M12: server validation errors (status 422 from validate.ts middleware)
    // include a per-issue details array. Surfaces as inline form errors in
    // editors that need per-field feedback (e.g. ChainEditor).
    public details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken() || (cloudTokenGetter ? await cloudTokenGetter() : null);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(path, { ...options, headers });
  captureServerClock(res);
  const requestId = res.headers.get("x-request-id") ?? undefined;

  if (res.status === 401) {
    clearToken();
    // Redirect to /login on session-expiry — but NEVER from a page where doing
    // so is pointless or harmful:
    //  - /login: redirecting /login -> /login just reloads the page. With a
    //    stale/expired session, bootstrap's getMe 401s here, which turned into
    //    a reload-every-few-seconds loop. Let the auth provider sign the stale
    //    session out instead of hard-reloading.
    //  - /auth/*: OAuthCallback and AuthConfirm validate the session and
    //    provision the account themselves; a first-time login legitimately
    //    401s getMe before provisioning runs, and bouncing would abort it
    //    ("signed in, landed back on login").
    //  - /invite/* and /r/*: PUBLIC pages, reached by people who are not signed
    //    in and are not being asked to be. They do their own work over
    //    publicRequest, which never 401s — but a stale session on the same
    //    device does, because the auth provider bootstraps getMe across the
    //    whole tree. Bouncing an invitee to a login form for an account they do
    //    not have yet ends the invite. Note this reproduces only WITH an
    //    existing session, so a clean browser profile will not show it.
    const path = typeof window !== "undefined" ? window.location.pathname : "";
    const PUBLIC_PREFIXES = ["/login", "/auth/", "/invite/", "/r/"];
    if (path && !PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
      window.location.href = "/login";
    }
    throw new ApiError(401, "Unauthorized", undefined, requestId);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body.error?.message || body.message || res.statusText,
      body.error?.code,
      requestId,
      Array.isArray(body.error?.details) ? body.error.details : undefined,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * Public HTTP request — no Authorization header, no auto-logout on 401.
 * Use for invite-token and review-link endpoints where the visitor is not
 * yet authenticated.
 */
export async function publicRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  // RFC 6265 — explicit credentials so the recipient session cookie rides
  // along even if topology shifts to cross-origin (CDN, separate API host,
  // embed widget). Same-origin nginx proxy works without this today, but
  // the failure mode (silent cookie drop → infinite needs_otp loop) is
  // expensive to diagnose and the include opt-in costs nothing at the
  // current topology.
  const res = await fetch(path, { ...options, headers, credentials: "include" });
  captureServerClock(res);

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      body.error?.message || body.message || res.statusText,
      body.error?.code,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}
