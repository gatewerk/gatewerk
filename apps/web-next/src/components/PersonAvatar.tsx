/**
 * PersonAvatar — a square tile that shows a reviewer's uploaded photo when
 * one exists, falling back to initials otherwise. `userId` is only ever
 * passed for the CURRENT signed-in reviewer today — avatars are self-view
 * only (no lookup-by-email exists yet), so every call site resolves "is
 * this row about me?" itself and passes `null` for anyone else, which
 * always renders the initials fallback.
 *
 * Whether a photo actually exists is discovered from the `<img>` itself
 * (onError), the same pattern AccountPane's AccountAvatar uses — GET
 * /avatar/:id 404s cleanly when there's none, so no second source of
 * truth (a "has_avatar" field) is needed.
 */
import { useEffect, useState } from "react";
import { avatarUrl } from "@gatewerk/web-core/api/auth";

interface Props {
  userId: string | null;
  fallback: string;
  size: number;
  radius: number;
  background: string;
  border: string;
  color: string;
  fontSize: number;
}

export function PersonAvatar({ userId, fallback, size, radius, background, border, color, fontSize }: Props) {
  const [failed, setFailed] = useState(!userId);

  // Resets the fallback state when the row switches to a different person
  // (or none) — without this, a component instance a list happens to reuse
  // across rows could keep showing a stale photo or a stale fallback.
  useEffect(() => {
    setFailed(!userId);
  }, [userId]);

  const shellStyle = {
    width: size,
    height: size,
    borderRadius: radius,
    background,
    border,
    flexShrink: 0,
    overflow: "hidden" as const,
  };

  if (userId && !failed) {
    return (
      <div className="flex items-center justify-center" style={shellStyle}>
        <img
          src={avatarUrl(userId)}
          alt=""
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-center font-semibold"
      style={{ ...shellStyle, color, fontSize }}
    >
      {fallback}
    </div>
  );
}
