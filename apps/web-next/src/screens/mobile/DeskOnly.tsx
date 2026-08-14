/**
 * The honest answer for a screen that has no phone layout.
 *
 * Deliberately not a redirect: a reviewer who taps a bookmark should be told
 * why the screen is not here, not silently moved somewhere they did not ask
 * for. On a phone you act on work, you do not
 * author it.
 */
import { Monitor } from "lucide-react";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";

export function DeskOnly({ what }: { what: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <Monitor size={26} style={{ color: "var(--gw-t8)" }} />
      <h1
        className="font-display text-t1"
        style={{ fontSize: 19, fontWeight: 600, marginTop: 16 }}
      >
        {what} needs a wider screen
      </h1>
      <p
        className="text-t6"
        style={{ fontSize: 13.5, lineHeight: 1.6, marginTop: 8, maxWidth: 300 }}
      >
        This screen is built for a desk. Open Gatewerk on a laptop or tablet to
        use it.
      </p>
      <p
        className="font-mono text-t9"
        style={{ fontSize: 11.5, marginTop: 20, maxWidth: 300 }}
      >
        You can still read and decide on reviews here.
      </p>
    </div>
  );
}

/** Renders the real screen on a laptop and the explanation on a phone. */
export function DeskOnlyOnNarrow({
  what,
  children,
}: {
  what: string;
  children: React.ReactNode;
}) {
  const narrow = useNarrowViewport();
  return narrow ? <DeskOnly what={what} /> : <>{children}</>;
}
