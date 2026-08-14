import { useEffect, useRef, useState } from "react";
import { request } from "@gatewerk/web-core/api/client/http";
import { backoffMs, type LiveEvent } from "@gatewerk/web-core/lib/live-events";

export type LiveStatus = "connecting" | "connected" | "reconnecting" | "closed";

interface UseLiveEventsOptions {
  enabled?: boolean;
  onEvent: (event: LiveEvent) => void;
}

interface TicketResponse {
  ticket: string;
  expires_in: number;
}

/**
 * Subscribe the dashboard to the live-feed SSE endpoint. Handles the two-
 * step auth (POST /events/ticket → GET /events/stream?ticket=...) because
 * browser EventSource cannot send the Authorization header. Reconnects
 * with exponential backoff on any stream error.
 */
export function useLiveEvents({
  enabled = true,
  onEvent,
}: UseLiveEventsOptions): { status: LiveStatus } {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const scheduleRetry = () => {
      if (cancelled) return;
      setStatus("reconnecting");
      const delay = backoffMs(attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    async function connect() {
      if (cancelled) return;
      try {
        const { ticket } = await request<TicketResponse>("/api/v1/events/ticket", {
          method: "POST",
        });
        if (cancelled) return;

        const url = `/api/v1/events/stream?ticket=${encodeURIComponent(ticket)}`;
        eventSource = new EventSource(url);

        eventSource.onopen = () => {
          attempt = 0;
          setStatus("connected");
        };

        eventSource.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data) as LiveEvent;
            onEventRef.current(data);
          } catch {
            /* malformed frame — server should never send this, ignore */
          }
        };

        eventSource.onerror = () => {
          eventSource?.close();
          eventSource = null;
          scheduleRetry();
        };
      } catch {
        scheduleRetry();
      }
    }

    setStatus("connecting");
    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      eventSource?.close();
      setStatus("closed");
    };
    // onEvent is captured via ref on every render so the subscription does
    // not reopen when the caller passes a new inline callback. Only `enabled`
    // should drive reconnection. Adding `onEvent` to deps would produce a
    // connect/disconnect storm on every parent render — the SSE handshake
    // is ~2 round trips, a classic infinite-reconnect footgun.
  }, [enabled]);

  return { status };
}
