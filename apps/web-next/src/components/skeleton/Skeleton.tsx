/**
 * Skeleton — reserved-dimension loading placeholder. Sibling of the
 * empty-state system: an empty state says "nothing lives here", a skeleton
 * says "content is coming and this is its shape". Blocks reserve the real
 * content's dimensions so nothing shifts when data lands.
 *
 * Fill levels follow the bespoke skeleton this generalizes
 * (ReviewDetail.tsx): line-rgb at .05-.08 alpha, radius near the real
 * content's. Do not render one for waits under ~150ms; show nothing instead.
 */
interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function Skeleton({
  width = "100%",
  height = 14,
  radius = 6,
  className = "",
  style,
}: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`motion-safe:animate-pulse ${className}`}
      style={{
        width,
        height,
        borderRadius: radius,
        background: "rgba(var(--gw-line-rgb),.07)",
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

interface SkeletonRowsProps {
  count?: number;
  rowHeight?: number;
  gap?: number;
  className?: string;
}

/**
 * A column of row-shaped blocks for list columns. Rows fade slightly toward
 * the bottom so the block reads as "a list loading", not a wall.
 */
export function SkeletonRows({ count = 6, rowHeight = 64, gap = 8, className = "" }: SkeletonRowsProps) {
  return (
    <div aria-hidden="true" className={`flex flex-col ${className}`} style={{ gap }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={rowHeight} radius={10} style={{ opacity: Math.max(0.35, 1 - i * 0.13) }} />
      ))}
    </div>
  );
}
