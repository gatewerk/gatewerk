export const DATE_PRESETS: { label: string; from: string; to: string }[] = (() => {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const sub = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - days);
    return d;
  };
  return [
    { label: "Today", from: fmt(today), to: fmt(today) },
    { label: "Last 7 days", from: fmt(sub(7)), to: fmt(today) },
    { label: "Last 30 days", from: fmt(sub(30)), to: fmt(today) },
    { label: "Last 60 days", from: fmt(sub(60)), to: fmt(today) },
  ];
})();

export function dateRangeLabel(from: string, to: string): string {
  const preset = DATE_PRESETS.find((p) => p.from === from && p.to === to);
  if (preset) return preset.label;
  const fmtShort = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  if (from && to) return `${fmtShort(from)} to ${fmtShort(to)}`;
  if (from) return `From ${fmtShort(from)}`;
  return `Until ${fmtShort(to)}`;
}
