/**
 * NotificationsPane — category × channel notification preference matrix.
 *
 * Columns: In-app (locked, always on), Email (Toggle), Slack (Toggle disabled).
 * Rows: categoriesWithEvents() (categories at least one event maps to; today
 * that is oversight and my_activity, workspace and updates have no events).
 * Below the matrix: timezone select, quiet-hours start/end, daily digest on/off.
 *
 * Digest send time is NOT user-configurable despite `NotificationPrefs.digest.at`
 * existing in the schema: the backend cron (oss.notification-digest) fires once
 * for the whole instance at a fixed UTC time, gated by a single instance-wide
 * idempotency row, not a per-reviewer one — so there is nowhere for a per-user
 * time to plug in yet. No time picker is rendered here for that reason (a
 * control that silently does nothing is worse than no control); `digest.at` and
 * `setDigestAt` stay in the schema/logic layer for when real per-user scheduling
 * is built.
 *
 * Data: seeded from GET /api/v1/auth/preferences via useQuery(['preferences']).
 * Mutations: PUT /api/v1/auth/preferences via useMutation on any change, toast on success.
 * Local state mirrors the server response; changes apply immediately and persist in bg.
 *
 * Styling: theme tokens only, elevation-only separation, no dashes in copy.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { categoriesWithEvents, DEFAULT_NOTIFICATION_PREFS } from "@gatewerk/shared";
import type { NotificationPrefs, NotificationCategory } from "@gatewerk/shared";
import { Toggle } from "./_shared/Toggle";
import { CARD_SHELL, SectionRule } from "./_shared/ui";
import { SelectMenu, type SelectOption } from "../templates/_ui";
import { getPreferences, updatePreferences } from "~/api/preferences";
import { getSlackStatus } from "~/api/slack";
import { isSlackChannelDisabled } from "./integrations-logic";
import {
  toggleChannel,
  setDigestEnabled,
  setQuietHours,
  setTimezone,
  categoryLabel,
  categoryHelper,
} from "./notification-prefs-logic";

// ── timezone list ─────────────────────────────────────────────────────────────

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Zurich",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
  "Pacific/Auckland",
];

const TIMEZONE_OPTIONS: SelectOption[] = [
  { value: "", label: "Browser default" },
  ...TIMEZONES.map((tz) => ({ value: tz, label: tz.replace(/_/g, " ") })),
];

// ── time input ────────────────────────────────────────────────────────────────
//
// A SelectMenu, not a native `<input type="time">` — same reasoning
// DateRangePopover already gave for replacing `<input type="date">`: native
// time inputs render the browser's own picker chrome (the focused segment's
// highlight colour, e.g., is a fixed platform blue no CSS can touch) and it
// breaks the app's dark theme rather than sitting inside it. Using SelectMenu
// also means this now shares Timezone's exact box (height, radius, border)
// instead of merely approximating it with hand-rolled styles.
//
// 30-minute increments: coarser than the native input's per-minute precision,
// but nothing about a quiet-hours window needs finer control than the half
// hour, and it keeps the dropdown a fixed 48-row list instead of 1440.

function formatTimeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

const TIME_OPTIONS: SelectOption[] = Array.from({ length: 48 }, (_, i) => {
  const value = `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}`;
  return { value, label: formatTimeLabel(value) };
});

function TimeInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  return (
    <SelectMenu
      value={value}
      onChange={onChange}
      options={TIME_OPTIONS}
      ariaLabel={ariaLabel ?? "Time"}
      minWidth={100}
    />
  );
}

// ── main pane ─────────────────────────────────────────────────────────────────

export function NotificationsPane() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["preferences"],
    queryFn: getPreferences,
    staleTime: 60_000,
  });

  const { data: slackStatus } = useQuery({
    queryKey: ["slack-status"],
    queryFn: getSlackStatus,
    staleTime: 30_000,
  });
  const slackConnected = slackStatus?.connected ?? false;

  // Local state: seeded from server, mutated locally on every change.
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

  // Seed local state once the server response arrives.
  useEffect(() => {
    if (data) {
      setPrefs(data.notifications);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: updatePreferences,
    onSuccess: () => {
      toast.success("Preferences saved");
      void queryClient.invalidateQueries({ queryKey: ["preferences"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not save preferences");
    },
  });

  function persist(next: NotificationPrefs) {
    setPrefs(next);
    mutation.mutate({ notifications: next });
  }

  function handleToggleChannel(category: NotificationCategory, channel: "email" | "slack") {
    persist(toggleChannel(prefs, category, channel));
  }

  function handleDigestEnabled(enabled: boolean) {
    persist(setDigestEnabled(prefs, enabled));
  }

  function handleQuietStart(start: string) {
    const current = prefs.quiet_hours;
    persist(setQuietHours(prefs, { start, end: current?.end ?? "07:00" }));
  }

  function handleQuietEnd(end: string) {
    const current = prefs.quiet_hours;
    persist(setQuietHours(prefs, { start: current?.start ?? "22:00", end }));
  }

  function handleQuietEnabled(enabled: boolean) {
    if (enabled) {
      persist(setQuietHours(prefs, { start: "22:00", end: "07:00" }));
    } else {
      persist(setQuietHours(prefs, null));
    }
  }

  function handleTimezone(tz: string) {
    persist(setTimezone(prefs, tz || null));
  }

  const quiet = prefs.quiet_hours;
  // Only render a row for a category at least one event can actually fire
  // into; workspace and updates are declared and stored but currently dead.
  const rows = categoriesWithEvents();

  return (
    <>
      {/* ── Matrix ── */}
      <section className="flex flex-col gap-3">
        <SectionRule label="Notification channels" />

        {/* Header row — px-4 matches the panel rows' own inset below it; the
            header used to sit outside that inset, so its columns and the
            toggles under them drifted apart at every column boundary. */}
        <div
          className="mb-1 grid items-center px-4"
          style={{ gridTemplateColumns: "1fr 80px 80px 80px" }}
        >
          <span />
          <span
            className="text-center text-[11px] font-medium"
            style={{ color: "var(--gw-t8)" }}
          >
            In app
          </span>
          <span
            className="text-center text-[11px] font-medium"
            style={{ color: "var(--gw-t8)" }}
          >
            Email
          </span>
          <span
            className="text-center text-[11px] font-medium"
            style={{ color: "var(--gw-t8)" }}
          >
            Slack
          </span>
        </div>

        {/* Category rows — CARD_SHELL's chrome (Security's card language), its
            own padding zeroed out since the grid columns need to align with
            the header row above, which each row's own px-4/py-3 already
            handles. */}
        <div style={{ ...CARD_SHELL, padding: 0 }}>
          {rows.map((cat, i) => {
            const isLast = i === rows.length - 1;
            return (
              <div
                key={cat}
                className="grid items-center px-4 py-3"
                style={{
                  gridTemplateColumns: "1fr 80px 80px 80px",
                  borderBottom: isLast
                    ? "none"
                    : "1px solid rgba(var(--gw-line-rgb),.06)",
                }}
              >
                {/* Label + helper */}
                <div className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
                    {categoryLabel(cat)}
                  </span>
                  <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
                    {categoryHelper(cat)}
                  </span>
                </div>

                {/* In-app — always on, not toggleable */}
                <div className="flex justify-center">
                  <span
                    className="text-[11px] font-medium"
                    style={{ color: "var(--gw-t8)" }}
                    title="In app notifications are always on"
                  >
                    always
                  </span>
                </div>

                {/* Email */}
                <div className="flex justify-center">
                  <Toggle
                    checked={prefs.channels[cat].email}
                    onChange={() => handleToggleChannel(cat, "email")}
                    aria-label={`${categoryLabel(cat)} email notifications`}
                  />
                </div>

                {/* Slack — enabled once a workspace is connected (Stage 4b) */}
                <div className="flex flex-col items-center gap-0.5">
                  <Toggle
                    checked={prefs.channels[cat].slack}
                    onChange={() => handleToggleChannel(cat, "slack")}
                    disabled={isSlackChannelDisabled(slackConnected)}
                    aria-label={`${categoryLabel(cat)} Slack notifications`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Slack connect hint (only when not connected) */}
        {!slackConnected && (
          <p className="mt-2 text-[11px]" style={{ color: "var(--gw-t8)" }}>
            Connect Slack in Integrations to enable Slack notifications.
          </p>
        )}
      </section>

      {/* ── Delivery schedule ── */}
      <section className="flex flex-col gap-3">
        <SectionRule label="Delivery schedule" />

        <div style={{ ...CARD_SHELL, padding: 0 }}>
          {/* Timezone */}
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.06)" }}
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
                Timezone
              </span>
              <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
                Used for quiet hours
              </span>
            </div>
            <SelectMenu
              value={prefs.timezone ?? ""}
              onChange={handleTimezone}
              options={TIMEZONE_OPTIONS}
              ariaLabel="Timezone"
              align="right"
              minWidth={168}
            />
          </div>

          {/* Quiet hours */}
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.06)" }}
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
                Quiet hours
              </span>
              <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
                Pause email and Slack notifications during these hours
              </span>
            </div>
            {/* Toggle is the LAST child so it stays pinned to the row's
                right edge (this group is right-aligned by the parent's
                justify-between) — the time range inserts to its LEFT when
                enabled, instead of the toggle itself shifting position. */}
            <div className="flex items-center gap-2">
              {quiet !== null && (
                <div className="flex items-center gap-1.5">
                  <TimeInput
                    value={quiet.start}
                    onChange={handleQuietStart}
                    ariaLabel="Quiet hours start"
                  />
                  <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
                    to
                  </span>
                  <TimeInput
                    value={quiet.end}
                    onChange={handleQuietEnd}
                    ariaLabel="Quiet hours end"
                  />
                </div>
              )}
              <Toggle
                checked={quiet !== null}
                onChange={handleQuietEnabled}
                aria-label="Enable quiet hours"
              />
            </div>
          </div>

          {/* Daily digest */}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium" style={{ color: "var(--gw-t2)" }}>
                Daily digest
              </span>
              <span className="text-[11px]" style={{ color: "var(--gw-t7)" }}>
                {/* Fixed instance-wide schedule, not per-user yet — see the
                    file header for why a time picker isn't offered here. */}
                Sent daily at 9:00 AM UTC instead of per-event emails
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Toggle
                checked={prefs.digest.enabled}
                onChange={handleDigestEnabled}
                aria-label="Daily digest"
              />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
