/**
 * Metrics — four headline numbers, the decision split, and the busiest
 * templates.
 *
 * No design source exists for this screen: the full-app prototype's rail is
 * Inbox, History, Templates and Notes, and Metrics appears only in the nav
 * drawer. So this keeps apps/web's information design and restates it in
 * web-next's tokens rather than inventing a second visual language for one
 * screen.
 *
 * `reviews_per_day` comes back on the same response and is rendered nowhere,
 * here or in apps/web. A trend line is the obvious use for it, and equally
 * obviously not something to invent without a design.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { stats } from "@gatewerk/web-core/api/stats";
import { formatDuration } from "@gatewerk/web-core/lib/utils";
import { RETRY_WARN_PERCENT, buildMetricsModel } from "./metrics-model";

const SLICE_COLOR: Record<string, string> = {
  approved: "rgba(var(--gw-green-rgb),.5)",
  rejected: "rgba(var(--gw-red-rgb),.5)",
  edited: "rgba(var(--gw-amber-rgb),.5)",
  retried: "rgba(var(--gw-blue-rgb),.5)",
};

export function Metrics() {
  useEffect(() => {
    document.title = "Metrics · Gatewerk";
  }, []);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["stats"],
    queryFn: stats.get,
  });

  if (isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <div
          role="status"
          aria-label="Loading metrics"
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            border: "2px solid rgba(var(--gw-line-rgb),.15)",
            borderTopColor: "var(--gw-t4)",
            animation: "spin 1s linear infinite",
          }}
        />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="grid h-full place-items-center">
        <div className="text-center">
          <AlertCircle size={20} className="mx-auto mb-2 text-t9" />
          <p className="text-t8" style={{ fontSize: 12 }}>
            {error instanceof Error ? error.message : "No data"}
          </p>
          <button
            onClick={() => refetch()}
            className="mt-2 text-t6 transition-colors hover:text-t2"
            style={{ fontSize: 11, background: "none", border: "none", cursor: "pointer" }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const m = buildMetricsModel(data);

  return (
    <div className="flex h-full flex-col overflow-y-auto px-10 py-10">
      <div className="grid grid-cols-4">
        <Stat value={String(m.total)} label="Reviews" sub={`${m.pending} pending`} />
        <Stat value={formatDuration(data.avg_review_time_ms)} label="Avg time" sub="to decision" />
        <Stat
          value={`${m.approvalPercent}%`}
          label="Approved"
          sub={`${m.approved} of ${m.decided}`}
          tone="green"
        />
        <Stat
          value={`${m.retryPercent}%`}
          label="Retried"
          sub={`${m.retried} of ${m.decided}`}
          tone={m.retryPercent > RETRY_WARN_PERCENT ? "amber" : undefined}
        />
      </div>

      {m.slices.length > 0 && (
        <div className="mt-12">
          <div className="flex overflow-hidden rounded-full" style={{ height: 8 }}>
            {m.slices.map((s) => (
              <div
                key={s.key}
                style={{ width: `${s.percent}%`, background: SLICE_COLOR[s.key] }}
              />
            ))}
          </div>
          <div className="mt-2.5 flex gap-6">
            {m.slices.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5" style={{ fontSize: 11 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: SLICE_COLOR[s.key],
                  }}
                />
                <span className="text-t6">{s.label}</span>
                <span className="font-medium tabular-nums text-t5">{s.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {m.templates.length > 0 && (
        <div className="mt-12 flex-1 space-y-2">
          {m.templates.map((t) => (
            <div key={t.slug} className="flex items-center gap-4" style={{ height: 32 }}>
              <span
                className="w-12 shrink-0 text-right font-semibold tabular-nums text-t3"
                style={{ fontSize: 14 }}
              >
                {t.count}
              </span>
              <div
                className="relative h-full flex-1 overflow-hidden rounded-md"
                style={{ background: "rgba(var(--gw-hi-rgb),.04)" }}
              >
                <div
                  className="absolute inset-y-0 left-0 rounded-md"
                  style={{ width: `${t.percent}%`, background: "rgba(var(--gw-green-rgb),.12)" }}
                />
                <span
                  className="relative flex h-full items-center px-3 font-mono text-t6"
                  style={{ fontSize: 11 }}
                >
                  {t.slug}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  value,
  label,
  sub,
  tone,
}: {
  value: string;
  label: string;
  sub: string;
  tone?: "green" | "amber";
}) {
  const color = tone === "green" ? "var(--gw-green-d)" : tone === "amber" ? "var(--gw-amber-t)" : "var(--gw-t1)";
  return (
    <div className="pr-8">
      <p
        className="font-display tabular-nums"
        style={{ margin: 0, fontSize: 34, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color }}
      >
        {value}
      </p>
      <p className="mt-1.5 text-t5" style={{ margin: "6px 0 0", fontSize: 13 }}>
        {label}
      </p>
      <p className="text-t8" style={{ margin: 0, fontSize: 11 }}>
        {sub}
      </p>
    </div>
  );
}
