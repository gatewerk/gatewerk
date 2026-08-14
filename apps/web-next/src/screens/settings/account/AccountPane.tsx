/**
 * Account — profile and preferences, per the Redesign prototype (manifest
 * §2.1) reconciled against what the API actually offers:
 * - Name: real inline edit via updateProfile({ name }).
 * - Email: READ-ONLY — no email-change endpoint exists; the prototype's
 *   "Change" link would be a dead promise, so it is not rendered.
 * - Password: "Update" opens a modal with a current/new/confirm form, on the
 *   same voluntary-change path PUT /profile already exposes (PasswordModal,
 *   reusing ActionModal's dialog chrome). It used to navigate to
 *   /change-password, but that screen is the forced first-login flow only —
 *   it guards on `must_change_password` and bounces anyone else straight
 *   back to "/", which read as the button silently doing nothing.
 * - Theme: the prototype's System/Dark/Light pills, wired to the REAL theme
 *   store (the prototype's own picker was a stub; this one works and stays in
 *   sync with the rail toggle because both write the same store).
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { Camera, Check, Copy, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { avatarUrl, deleteAvatar, updateProfile, uploadAvatar } from "@gatewerk/web-core/api/auth";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import {
  ActionLink,
  CARD_SHELL,
  PaneHeader,
  RowSaveCancel,
  RowTextInput,
  RowValue,
  SettingsRow,
} from "../_shared/ui";
import { NotificationsPane } from "../NotificationsPane";
import { IntegrationsPane } from "../IntegrationsPane";
import { ShortcutsPane } from "../shortcuts/ShortcutsPane";
import { OnboardingReplaySection } from "./OnboardingReplaySection";
import { PasswordModal } from "./PasswordModal";
import {
  applyTheme,
  prefersDark,
  readPref,
  resolveTheme,
  setPref,
  type ThemePref,
} from "~/theme/theme-store";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

function SignOutButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="gw-focus-ring shrink-0 cursor-pointer rounded-[5px] border-none font-mono text-[10px] font-semibold uppercase transition-colors"
      style={{
        letterSpacing: ".1em",
        color: "var(--gw-red-t)",
        background: hovered ? "rgba(var(--gw-red-rgb),.18)" : "rgba(var(--gw-red-rgb),.1)",
        padding: "3px 9px",
      }}
    >
      Sign out
    </button>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

const AVATAR_SIZE = 256;
const ALLOWED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

/**
 * Center-crops to a square (a non-square photo would otherwise squash) and
 * scales to AVATAR_SIZE, re-encoded as JPEG — small and predictable
 * regardless of what the original file was, so the upload stays well under
 * the server's cap without the user having to think about file size.
 *
 * Two things a first version of this got wrong, both from the same root
 * cause — trusting `<img>`'s onload as proof the browser had finished
 * decoding pixels, which is not actually part of what onload guarantees:
 *   1. `img.decode()` is the real signal; onload alone occasionally raced
 *      it, and drawImage on a not-yet-decoded image draws nothing.
 *   2. When drawImage draws nothing (or only part of the frame), the
 *      canvas's untouched area is TRANSPARENT — and JPEG cannot represent
 *      transparency, so the encoder flattens it to solid BLACK, not white,
 *      on export. The fillRect below removes that failure mode entirely:
 *      even if drawImage were to fail again for some other reason, the
 *      output is a plain white square, not a black one masquerading as a
 *      successful upload.
 */
async function resizeToAvatarDataUrl(file: File): Promise<string> {
  const dataUrl = await readAsDataUrl(file);
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);

  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

  return canvas.toDataURL("image/jpeg", 0.85);
}

/**
 * The identity card's avatar tile, now a photo when one is set. Whether one
 * exists is discovered from the `<img>` itself (onLoad/onError) rather than
 * a field on the reviewer object — GET /avatar/:id already 404s cleanly
 * when there's none, so a second source of truth isn't needed.
 */
function AccountAvatar({ user }: { user: { id: string; name: string } }) {
  const [hovered, setHovered] = useState(false);
  const [hasPhoto, setHasPhoto] = useState(false);
  const [imgSrc, setImgSrc] = useState(() => `${avatarUrl(user.id)}?v=0`);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function bustCache() {
    setImgSrc(`${avatarUrl(user.id)}?v=${Date.now()}`);
  }

  async function handleFile(file: File) {
    if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
      toast.error("Photo must be PNG, JPEG, or WebP");
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await resizeToAvatarDataUrl(file);
      await uploadAvatar(dataUrl);
      bustCache();
      toast.success("Photo updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not upload photo");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await deleteAvatar();
      setHasPhoto(false);
      toast.success("Photo removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not remove photo");
    }
  }

  return (
    <div
      className="relative shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        aria-label={hasPhoto ? "Change photo" : "Add photo"}
        className="gw-focus-ring relative flex cursor-pointer items-center justify-center overflow-hidden border-none p-0"
        style={{
          width: 46,
          height: 46,
          borderRadius: 13,
          background: "var(--gw-avatar)",
          border: "1px solid rgba(var(--gw-line-rgb),.08)",
        }}
      >
        {hasPhoto ? (
          <img
            src={imgSrc}
            alt=""
            onError={() => setHasPhoto(false)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span className="text-[15px] font-semibold" style={{ color: "var(--gw-t3)" }}>
            {initials(user.name)}
          </span>
        )}
        {/* Discovers whether a photo actually exists — a hidden probe image
            so a 404 (no avatar set) never shows a broken-image icon. */}
        {!hasPhoto && (
          <img
            src={imgSrc}
            alt=""
            style={{ display: "none" }}
            onLoad={() => setHasPhoto(true)}
          />
        )}
        {(hovered || uploading) && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: "rgba(10,10,8,.5)" }}
          >
            {uploading ? (
              <Loader2 size={15} className="animate-spin" color="#fff" />
            ) : (
              <Camera size={15} color="#fff" strokeWidth={1.8} />
            )}
          </div>
        )}
      </button>
      {hasPhoto && hovered && !uploading && (
        <button
          type="button"
          onClick={handleRemove}
          aria-label="Remove photo"
          className="gw-focus-ring absolute flex cursor-pointer items-center justify-center border-none"
          style={{
            width: 16,
            height: 16,
            borderRadius: "50%",
            top: -4,
            right: -4,
            background: "var(--gw-red-t)",
            color: "var(--gw-panel-a)",
          }}
        >
          <X size={10} strokeWidth={2.5} />
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleFile(file);
        }}
      />
    </div>
  );
}

export function AccountPane() {
  const { user, updateUser, logout } = useAuth();
  const navigate = useNavigate();
  // The two grids below fix each column at a 480px floor (comment at line
  // ~360), which is correct at the pane's 1080px desktop width but is wider
  // than an entire phone screen. On narrow, drop to one column instead of
  // adding a second breakpoint: this reads useNarrowViewport, the same
  // signal the rest of the mobile work hangs off, not a new media query.
  const narrow = useNarrowViewport();

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [themePref, setThemePref] = useState<ThemePref>(() => readPref());

  const nameMutation = useMutation({
    mutationFn: (name: string) => updateProfile({ name }),
    onSuccess: (reviewer) => {
      updateUser(reviewer);
      setEditingName(false);
      toast.success("Name updated");
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not update name");
    },
  });

  function startEditName() {
    setNameDraft(user?.name ?? "");
    setEditingName(true);
  }

  // Escape cancels the name edit (respecting anything above it at capture).
  useEffect(() => {
    if (!editingName) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setEditingName(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingName]);

  const [passwordModalOpen, setPasswordModalOpen] = useState(false);

  function chooseTheme(pref: ThemePref) {
    setThemePref(pref);
    setPref(pref);
    applyTheme(resolveTheme(pref, prefersDark()));
  }

  async function handleSignOut() {
    await logout();
    navigate("/login", { replace: true });
  }

  const [idCopied, setIdCopied] = useState(false);
  function copyUserId() {
    if (!user) return;
    navigator.clipboard.writeText(user.id).then(
      () => {
        toast.success("User ID copied");
        setIdCopied(true);
        setTimeout(() => setIdCopied(false), 1500);
      },
      () => toast.error("Failed to copy"),
    );
  }

  if (!user) return null;

  return (
    <>
      <PaneHeader title="Account" subtitle="Your profile and preferences" />

      {/* Two column grid: the identity card now joins this same
          auto-fit grid instead of spanning the full pane alone, halving it
          to the ~526px column width documented below rather than leaving a
          bare card over 1080 of otherwise-empty width.
          It's stacked in the LEFT cell, above Profile rows, rather than
          swapped side by side with them — the minimal move: nothing else on
          the pane needs to be re-paired or reordered, and no cell ends up
          holding one short card while its sibling runs taller. Notifications
          is what it pairs with, because that's already the grid's other
          half: same "your account settings" register as the card and the
          rows below it, and it was already sitting at the same row's top
          edge, so nothing here strands or gets stranded.
          Mechanic unchanged from 08-08: `repeat(auto-fit, minmax(480px,
          1fr))`, ProjectPane.tsx:224 — folds to one column under the floor
          width, same as its API Keys | Webhooks pair.
          480 is the floor: the widest thing on the left is the Name row mid
          edit (label 130 + gap 12 + RowTextInput 220 + gap 8 + RowSaveCancel
          ~104 ≈ 474px); the widest thing on the right is the Notification
          channels matrix, whose `1fr 80px 80px 80px` grid plus 32px of row
          padding needs roughly 420px before the label column gets unreadably
          tight. 480 clears both with a little headroom. */}
      <div
        className="grid items-start gap-7"
        style={{ gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "repeat(auto-fit, minmax(480px, 1fr))" }}
      >
        {/* Left column: identity card + profile rows — one "about you" stack */}
        <div className="flex flex-col gap-[26px]">
          {/* Identity card — manifest S1.1-S1.5. Half the pane now (its own
              grid column), not the full 1080. */}
          <div className="flex items-center gap-3.5" style={CARD_SHELL}>
            <AccountAvatar user={user} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold" style={{ color: "var(--gw-t2)" }}>
                {user.name}
              </div>
              <div className="mt-0.5 truncate font-mono text-[12px]" style={{ color: "var(--gw-t7)" }}>
                {user.email}
              </div>
            </div>
            <div className="flex shrink-0 items-center" style={{ gap: 8 }}>
              <span
                className="shrink-0 rounded-[5px] font-mono text-[10px] font-semibold uppercase"
                style={{
                  letterSpacing: ".1em",
                  color: "var(--gw-blue-t)",
                  border: "1px solid rgba(var(--gw-blue-rgb),.4)",
                  padding: "3px 9px",
                }}
              >
                {user.role}
              </span>
              {/* Same shape as the role badge (mono 10, radius 5, 3px/9px padding)
                  so the two read as one row, not a label plus a bolted-on link —
                  light red fill (not the outline destructive buttons use
                  elsewhere) since this is a step toward a state change, not the
                  genuinely destructive delete-account action below. */}
              <SignOutButton onClick={handleSignOut} />
            </div>
          </div>

          {/* Rows — manifest S1.6 */}
          <div className="flex flex-col">
            <SettingsRow
              label="Name"
              action={
                editingName ? undefined : <ActionLink onClick={startEditName}>Edit</ActionLink>
              }
            >
              {editingName ? (
                <RowValue>
                  <div className="flex items-center gap-2">
                    <RowTextInput
                      aria-label="Name"
                      autoFocus
                      width={220}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && nameDraft.trim()) nameMutation.mutate(nameDraft.trim());
                      }}
                    />
                    <RowSaveCancel
                      onSave={() => nameDraft.trim() && nameMutation.mutate(nameDraft.trim())}
                      onCancel={() => setEditingName(false)}
                      saving={nameMutation.isPending}
                      saveDisabled={!nameDraft.trim()}
                    />
                  </div>
                </RowValue>
              ) : (
                <RowValue>{user.name}</RowValue>
              )}
            </SettingsRow>

            {/* Email is read-only: no email-change endpoint exists, so no action
                link is drawn (a hint must be true). */}
            <SettingsRow label="Email" mono>
              <RowValue>{user.email}</RowValue>
            </SettingsRow>

            {/* Shown so a reviewer can copy their own id and hand it to whoever
                is generating them a "Gatewerk account required" share link —
                that link type takes a raw user id, and this was previously the
                only fact in the app with no way to find it. */}
            <SettingsRow
              label="User ID"
              mono
              onValueClick={copyUserId}
              onValueClickIcon={
                idCopied ? (
                  <Check size={12} strokeWidth={2} style={{ color: "var(--gw-green-t)" }} />
                ) : (
                  <Copy size={12} strokeWidth={1.9} />
                )
              }
              onValueClickLabel="Copy user ID"
            >
              <RowValue>{user.id}</RowValue>
            </SettingsRow>

            <SettingsRow
              label="Password"
              action={<ActionLink onClick={() => setPasswordModalOpen(true)}>Update</ActionLink>}
            >
              <RowValue>••••••••••••</RowValue>
            </SettingsRow>

            {/* Theme — manifest S1.7, wired to the real store. Composed through
                SettingsRow rather than hand-duplicating its shell, so the label
                column can't drift out of alignment with Name/Email/Password
                above it if labelWidth's default ever changes. */}
            <SettingsRow label="Theme" divider={false}>
              {/* One unified box, not three individually bordered pills — the
                  list header's SegmentedTabs treatment (~/components/
                  SegmentedTabs.tsx), sized to content rather than stretched.

                  All three segments are the SAME
                  width. Previously each was padded around its own label, so
                  System was visibly wider than Dark and the selected chip
                  changed shape as you moved between them. An inline grid of
                  three equal columns keeps the whole control sized to its
                  content, as before, while making every segment as wide as the
                  longest word. That is the same guarantee SegmentedTabs gives
                  through its `equalWidth` prop, whose own comment explains why:
                  the pill's shape should be stable whatever is selected. */}
              <div
                className="inline-grid items-center gap-[2px] rounded-[9px]"
                style={{
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  padding: 3,
                  background: "rgba(var(--gw-hi-rgb),.03)",
                  border: "1px solid rgba(var(--gw-line-rgb),.08)",
                }}
              >
                {THEME_OPTIONS.map((opt) => {
                  const on = themePref === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => chooseTheme(opt.value)}
                      className="gw-focus-ring cursor-pointer rounded-[6px] text-[12px] transition-colors"
                      style={{
                        padding: "5px 12px",
                        fontWeight: on ? 600 : 500,
                        color: on ? "var(--gw-t2)" : "var(--gw-t8)",
                        background: on ? "rgba(var(--gw-hi-rgb),.10)" : "transparent",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </SettingsRow>
          </div>
        </div>

        {/* NotificationsPane's root is a Fragment (two <section>s: channels
            and delivery schedule) — wrapped in its own flex column here so
            both sections land in ONE grid cell instead of flattening into
            the grid as two separate auto-placed items. gap-[26px] matches
            the vertical rhythm those two sections had as flattened siblings
            before this change. */}
        <div className="flex flex-col gap-[26px]">
          <NotificationsPane />
        </div>
      </div>

      {/* Merged IA: notifications (above), Slack
          and the shortcuts reference are all personal preferences, so they
          live here rather than as three more nav doors.

          These used to sit in their own capped
          640 column below the grid above — not named in the
          two-column ruling, so left alone at the time, but that reproduced
          the exact "two different right edges stacked" defect the grid
          above exists to remove, just one section lower. They join the same
          `repeat(auto-fit, minmax(480px, 1fr))` mechanic (ProjectPane.tsx:224)
          as the grid above, so the whole pane shares one right edge.

          IntegrationsPane and ShortcutsPane, not IntegrationsPane and
          OnboardingReplaySection, are the fixed pair here — always exactly
          two items, so this grid always fills exactly one row evenly split,
          the same "two fixed-content cards" shape SecurityPane.tsx:35-37
          uses for TwoFactorSection/LoginNotificationsSection. Both read fine
          at a ~526px half column: IntegrationsPane is already a single
          compact card (was fine even at 640 before); ShortcutsPane's rows
          are a short description plus 1-3 small keycaps (justify-between,
          same shape as NotificationsPane's own Timezone/Quiet-hours rows a
          column over), not the multi-field rows SessionsCard/
          LoginHistorySection have — those wanted full 1080 width
          (SecurityPane.tsx:17-25, and this pane's own Item 2 fix) because a
          Revoke/time cluster needed real row width to lay out; a bare
          description+keycap row stretched to full 1080 would just recreate
          that same dead-middle-space defect on Shortcuts instead. */}
      <div
        className="grid items-start gap-7"
        style={{ gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "repeat(auto-fit, minmax(480px, 1fr))" }}
      >
        <ShortcutsPane />
        <IntegrationsPane />
      </div>

      {/* OnboardingReplaySection is NOT a third item in the grid above:
          SecurityPane.tsx:20-24 documents why — at 1080 with a 480px floor,
          only two columns fit per row, so a third item does not get a third
          column, it wraps alone into row two's column one with row two's
          column two sitting empty beside it, the exact stranded-card look
          this whole pass exists to remove. It also renders conditionally
          (OnboardingReplaySection.tsx: returns null for an admin on a
          standalone build — no wizard row, no walkthrough row) which would
          make that third grid slot appear and disappear depending on who's
          signed in. Rendered here as its own plain full-width block instead:
          when present it naturally fills the pane's full 1080 (bounded only
          by Settings.tsx's own PANE_WIDTH, same as the identity card and
          both grids above); when its internal check returns null there is
          no DOM node at all — no empty box, no hole, nothing stranded.
          Handoff §E: a user who dismissed onboarding must always have a path
          back. Personal, like everything else on this pane. */}
      <OnboardingReplaySection />

      {passwordModalOpen && <PasswordModal onClose={() => setPasswordModalOpen(false)} />}
    </>
  );
}
