/**
 * Verbatim login copy from Gatewerk Login.dc.html.
 * Single source of truth — no dashes in any string.
 */

export const AUTH_COPY = {
  // Page heading (all login states share this title)
  title: "Sign in to Gatewerk",
  // Page sub-heading (login / 2FA / forgot / sent)
  sub: "Human oversight for AI agents",

  // Return-to variant inline note
  returnToNote: "Sign in to continue to your review.",

  // Login form
  emailPlaceholder: "Email",
  passwordPlaceholder: "Password",
  forgotLink: "Forgot password?",
  rememberLabel: "Remember me",
  signInButton: "Sign in",

  // 2FA state
  twofaHeading: "Two-factor authentication",
  twofaSub: "Enter the code from your authenticator app",
  twofaPlaceholder: "6-digit code",
  verifyButton: "Verify",
  backToSignIn: "Back to sign in",

  // Forgot state
  forgotHeading: "Forgot your password?",
  forgotSub: "Enter your email and we'll send you a reset link.",
  sendResetButton: "Send reset link",

  // Sent state
  sentHeading: "Check your inbox",
  sentBody:
    "If an account exists with that email, we sent a reset link. Check your spam folder if you don't see it.",

  // Footer
  footer: "Gatewerk · Open Source",
} as const;

/**
 * Password rules, mirrored from the server so the form can say no before the
 * network does. `apps/api/src/lib/password-policy.ts` is authoritative: it also
 * checks the password against Have I Been Pwned, which the client cannot and
 * must not do. A breached password therefore fails server side and arrives back
 * as an error message, which is why every screen renders the server's text
 * rather than a guess at it.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export const RESET_COPY = {
  title: "Reset your password",
  sub: "Choose a new password for your account",
  passwordPlaceholder: "New password",
  submit: "Set new password",
  backToSignIn: "Back to sign in",
  missingToken: "This reset link is not valid. Ask for a new one.",
  tooShort: `Password must be at least ${PASSWORD_MIN} characters`,
  tooLong: `Password must be at most ${PASSWORD_MAX} characters`,
  failed: "Could not reset your password. The link may have expired.",
  doneHeading: "Password updated",
  doneBody: "You can sign in with your new password now.",
  doneAction: "Sign in",
} as const;

export const CHANGE_COPY = {
  title: "Set your password",
  sub: "Choose a password before you continue",
  newLabel: "New password",
  newPlaceholder: `At least ${PASSWORD_MIN} characters`,
  confirmLabel: "Confirm password",
  confirmPlaceholder: "Enter your password again",
  submit: "Continue",
  mismatch: "Both passwords must match",
  tooShort: `Password must be at least ${PASSWORD_MIN} characters`,
  tooLong: `Password must be at most ${PASSWORD_MAX} characters`,
  failed: "Could not change your password",
} as const;

/**
 * Reviewer invitation. Copy is from the onboarding design
 * (Gatewerk Reviewer Invite.dc.html), which is the design authority for this
 * screen. Every string lives here rather than inline so the three phases can be
 * read as one piece of writing — the left panel makes a promise about what a
 * decision means, and the right panel has to keep it.
 */
export const INVITE_COPY = {
  // Left panel — constant across all three phases. The framing is the point:
  // most people arriving here have never been asked to oversee an agent before.
  brandEyebrow: "Reviewer invitation",
  brandHeadline: "You've been asked to help oversee an AI agent.",
  brandPoints: [
    "Agents pause on actions that need judgment and send them to you.",
    "You read it, adjust anything that's off, and approve or reject.",
    "Nothing runs until you decide. Your call is the final word.",
  ],
  // True as written: apps/api/src/routes/settings/team.ts:91 sets the expiry to
  // exactly seven days. If that changes, this line changes with it.
  brandFooter: "Secure invite link · expires in 7 days",

  // Phase 1 — accept
  invitedBy: (inviter: string) => `${inviter} invited you`,
  invitedByUnknown: "You've been invited",
  invitedTo: (team: string) => `to review for ${team}`,
  invitedToUnknown: "to help review an agent's work",
  teamLabel: "team",
  roleLabel: "role",
  emailLabel: "email",
  accept: "Accept invitation",
  decline: "Not you?",
  declineAction: "Decline",

  // Phase 2 — name and password
  nameEyebrow: "One detail",
  nameTitle: "What should teammates call you?",
  nameBody: "This name appears on the decisions you make, so others can see who reviewed what.",
  nameLabel: "Display name",
  namePlaceholder: "e.g. Dana Ruiz",
  passwordLabel: "Password",
  passwordPlaceholder: `At least ${PASSWORD_MIN} characters`,
  submit: "Enter Gatewerk",
  back: "Back",

  // Phase 3 — entering
  welcome: (first: string) => `Welcome, ${first}`,
  enteringBody: (team: string) => `You're on the ${team} team. Taking you to your first review…`,
  enteringBodyUnknown: "Taking you to your first review…",
  openingInbox: "Opening inbox",

  nameRequired: "Name is required",
  tooShort: `Password must be at least ${PASSWORD_MIN} characters`,
  tooLong: `Password must be at most ${PASSWORD_MAX} characters`,
  failed: "Could not create your account",
  goToSignIn: "Go to sign in",
  states: {
    invalid: {
      title: "Invite link is not valid",
      body: "This invite link is not valid. Ask your admin for a new one.",
    },
    expired: {
      title: "Invite expired",
      body: "This invite link has expired. Ask your admin for a new one.",
    },
    used: {
      title: "Invite already used",
      body: "This invite has already been accepted. Try signing in instead.",
    },
    error: {
      title: "Something went wrong",
      body: "We could not check this invite. Try again or ask your admin.",
    },
  },
} as const;
