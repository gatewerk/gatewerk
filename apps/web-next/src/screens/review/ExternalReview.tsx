/**
 * ExternalReview — the public recipient page at /r/:token.
 *
 * Design: Gatewerk External Review.dc.html. Wiring reference (not design):
 * apps/web/src/pages/TokenReview.tsx.
 *
 * No AppShell, no auth gate, no Toaster: every message this page has to give is
 * rendered inline. All API calls go through @/api/token-reviews (raw fetch +
 * publicRequest) — never through @/api/client/http's `request()`, which
 * hard-redirects to /login on 401 and would eject a recipient mid-flow.
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { TemplateActionConfigCanonical } from "@gatewerk/shared";
import { ApiError } from "@gatewerk/web-core/api/client/http";
import { tokenReviews, type TokenReviewData } from "@gatewerk/web-core/api/token-reviews";
import {
  QUESTION_TEXT_LIMITS,
  validateQuestionText,
} from "@gatewerk/web-core/state/token-review/recipient-actions-state";
import { useAuth } from "@gatewerk/web-core/hooks/use-auth";
import { ReviewFrame } from "./ReviewFrame";
import { StatusTile } from "./StatusTile";
import { CodeStep, EmailStep } from "./EmailOtpSteps";
import { ReviewReady } from "./ReviewReady";
import {
  RecipientActionModal,
  type RecipientActionKind,
} from "./RecipientActionModal";
import {
  codeErrorMessage,
  emailErrorMessage,
  isLockedError,
  loadFailureKind,
  usedDescription,
  type StatusKind,
} from "./recipient-state";

const OTP_COOLDOWN_MS = 60_000;
const ARM_TIMEOUT_MS = 3_000;

interface Terminal {
  kind: StatusKind;
  description?: string;
}

export default function ExternalReview() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const queryClient = useQueryClient();

  // Sticky across step-backs (the OTP steps re-render but must not lose these).
  const [senderHint, setSenderHint] = useState<string | undefined>(undefined);
  const [emailHint, setEmailHint] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);

  const [otpStep, setOtpStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [cooldownEndsAt, setCooldownEndsAt] = useState(0);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const [feedback, setFeedback] = useState("");
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);

  const [modal, setModal] = useState<RecipientActionKind | null>(null);
  const [modalText, setModalText] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);

  /** Set once a mutation reaches a terminal outcome; wins over query data. */
  const [terminal, setTerminal] = useState<Terminal | null>(null);

  const { data, isLoading, error } = useQuery<TokenReviewData>({
    queryKey: ["token-review", token],
    queryFn: () => tokenReviews.validate(token),
    enabled: !!token,
    retry: false,
  });

  useEffect(() => {
    document.title = "Review · Gatewerk";
  }, []);

  useEffect(() => {
    if (!data) return;
    if ("sender_hint" in data && data.sender_hint) setSenderHint(data.sender_hint);
    if (data.status === "valid" && data.kind === "needs_otp") {
      setEmailHint(data.recipient_email_hint);
      setSessionExpired(data.cookie_invalid === true);
    }
  }, [data]);

  // ── mutations ──────────────────────────────────────────────────────────────

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["token-review", token] });

  const requestOtpMutation = useMutation({
    mutationFn: (address: string) => tokenReviews.requestOtp(token, address),
    onSuccess: () => {
      setEmailError(null);
      setCodeError(null);
      setOtpStep("code");
      setCooldownEndsAt(Date.now() + OTP_COOLDOWN_MS);
    },
    onError: (err: unknown) => {
      if (isLockedError(err)) {
        setTerminal({ kind: "locked" });
        return;
      }
      setEmailError(emailErrorMessage(err));
    },
  });

  const verifyOtpMutation = useMutation({
    mutationFn: (value: string) => tokenReviews.verifyOtp(token, value),
    onSuccess: () => {
      setCode("");
      setCodeError(null);
      setSessionExpired(false);
      void invalidate();
    },
    onError: (err: unknown) => {
      if (isLockedError(err)) {
        setTerminal({ kind: "locked" });
        return;
      }
      const api = err instanceof ApiError ? err : null;
      if (api?.code === "code_expired") {
        // Bounce back to the email step (the typed address is preserved).
        setCode("");
        setCodeError(null);
        setOtpStep("email");
        setEmailError(emailErrorMessage(err));
        return;
      }
      setCodeError(codeErrorMessage(err));
    },
  });

  /** 410 / 401 during a mutation: let a refetch decide the real state. */
  const routeMutationFailure = (err: unknown): boolean => {
    const api = err instanceof ApiError ? err : null;
    if (api?.status === 410) {
      void invalidate();
      return true;
    }
    if (api?.status === 401) {
      if (api.code === "email_otp_required") {
        setOtpStep("email");
        setSessionExpired(true);
      }
      void invalidate();
      return true;
    }
    return false;
  };

  const actionMutation = useMutation({
    mutationFn: (action: TemplateActionConfigCanonical) =>
      tokenReviews
        .action(token, {
          action_id: action.id,
          feedback: feedback.trim() || undefined,
        })
        .then((res) => ({ res, action })),
    onSuccess: ({ res, action }) => {
      const decided = action.decision_value ?? res.decision;
      setTerminal({ kind: decided === "rejected" ? "rejected" : "approved" });
    },
    onError: (err: unknown) => {
      if (routeMutationFailure(err)) return;
      setTerminal({
        kind: "error",
        description:
          err instanceof ApiError ? err.message : "Failed to submit decision",
      });
    },
  });

  const closeModal = () => {
    setModal(null);
    setModalText("");
    setModalError(null);
  };

  const openModal = (kind: RecipientActionKind) => {
    setModalText("");
    setModalError(null);
    setModal(kind);
  };

  const onRecipientActionError = (err: unknown) => {
    if (routeMutationFailure(err)) {
      closeModal();
      return;
    }
    setModalError(
      err instanceof ApiError ? err.message : "That could not be submitted",
    );
  };

  const declineMutation = useMutation({
    mutationFn: () =>
      tokenReviews.decline(token, {
        decline_reason: modalText.trim() || undefined,
      }),
    onSuccess: () => {
      closeModal();
      setTerminal({ kind: "declined" });
    },
    onError: onRecipientActionError,
  });

  const questionsMutation = useMutation({
    mutationFn: () =>
      tokenReviews.raiseQuestions(token, { question_text: modalText.trim() }),
    onSuccess: () => {
      closeModal();
      setTerminal({ kind: "questions" });
    },
    onError: onRecipientActionError,
  });

  const modalPending = declineMutation.isPending || questionsMutation.isPending;
  const anyPending =
    modalPending ||
    actionMutation.isPending ||
    requestOtpMutation.isPending ||
    verifyOtpMutation.isPending;

  // ── keyboard + arming ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!armedId) return;
    const id = setTimeout(() => setArmedId(null), ARM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [armedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || anyPending) return;
      if (armedId) {
        setArmedId(null);
        return;
      }
      if (modal) {
        closeModal();
        return;
      }
      if (otpStep === "code") {
        setOtpStep("email");
        setCode("");
        setCodeError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyPending, armedId, modal, otpStep]);

  // ── handlers ───────────────────────────────────────────────────────────────

  const submitCode = (value: string) => {
    if (value.length === 6 && !verifyOtpMutation.isPending) {
      verifyOtpMutation.mutate(value);
    }
  };

  const onAction = (action: TemplateActionConfigCanonical) => {
    if (action.requires_feedback && feedback.trim().length === 0) {
      setArmedId(null);
      setFeedbackError("Add a note before submitting this decision.");
      return;
    }
    setFeedbackError(null);
    if (armedId !== action.id) {
      setArmedId(action.id);
      return;
    }
    setArmedId(null);
    actionMutation.mutate(action);
  };

  const submitModal = () => {
    if (modal === "decline") {
      declineMutation.mutate();
      return;
    }
    const check = validateQuestionText(modalText);
    if (!check.valid) {
      setModalError(
        check.trimmedLength > QUESTION_TEXT_LIMITS.max
          ? `Please shorten your questions to ${QUESTION_TEXT_LIMITS.max} characters or fewer.`
          : "Add at least a sentence so the reviewer can answer.",
      );
      return;
    }
    setModalError(null);
    questionsMutation.mutate();
  };

  const goToLogin = () => navigate(`/login?return_to=/r/${token}`);
  const switchAccounts = () => {
    logout();
    goToLogin();
  };

  // ── render ─────────────────────────────────────────────────────────────────

  const body = () => {
    if (terminal) {
      return (
        <StatusTile
          kind={terminal.kind}
          description={terminal.description}
          senderHint={senderHint}
          onCta={terminal.kind === "login" ? goToLogin : undefined}
        />
      );
    }

    if (isLoading || !token) {
      return (
        <div
          className="flex justify-center"
          style={{ padding: "44px 0 30px" }}
          aria-label="Loading review"
        >
          <Loader2 size={20} className="animate-spin text-t8" />
        </div>
      );
    }

    if (error || !data) {
      return (
        <StatusTile
          kind={loadFailureKind(error)}
          senderHint={senderHint}
          description={
            loadFailureKind(error) === "error" && error instanceof ApiError
              ? error.message
              : undefined
          }
        />
      );
    }

    if (data.status === "expired") {
      return <StatusTile kind="expired" senderHint={senderHint} />;
    }
    if (data.status === "revoked") {
      return <StatusTile kind="invalid" senderHint={senderHint} />;
    }
    if (data.status === "used") {
      return (
        <StatusTile
          kind="used"
          description={usedDescription(data.decision, data.decided_at)}
        />
      );
    }
    if (data.kind === "needs_login") {
      return <StatusTile kind="login" onCta={goToLogin} />;
    }
    if (data.kind === "account_mismatch") {
      return (
        <StatusTile
          kind="mismatch"
          senderHint={senderHint}
          description={`This link is not for your account. You are signed in as ${data.current_account_label}.`}
          onCta={switchAccounts}
        />
      );
    }
    if (data.kind === "needs_otp") {
      return otpStep === "email" ? (
        <EmailStep
          email={email}
          onEmail={(v) => {
            setEmail(v);
            setEmailError(null);
          }}
          onSubmit={() => requestOtpMutation.mutate(email.trim())}
          pending={requestOtpMutation.isPending}
          error={emailError}
          sessionExpired={sessionExpired}
          emailHint={emailHint || data.recipient_email_hint}
          senderHint={senderHint}
        />
      ) : (
        <CodeStep
          code={code}
          onCode={(v) => {
            setCode(v);
            setCodeError(null);
            submitCode(v);
          }}
          onSubmit={() => submitCode(code)}
          onBack={() => {
            setOtpStep("email");
            setCode("");
            setCodeError(null);
          }}
          onResend={() => requestOtpMutation.mutate(email.trim())}
          pending={verifyOtpMutation.isPending}
          resendPending={requestOtpMutation.isPending}
          error={codeError}
          emailHint={emailHint || data.recipient_email_hint}
          cooldownEndsAt={cooldownEndsAt}
        />
      );
    }

    return (
      <ReviewReady
        review={data.review}
        template={data.template}
        isPreview={data.is_preview === true}
        senderHint={senderHint}
        feedback={feedback}
        onFeedback={(v) => {
          setFeedback(v);
          if (feedbackError) setFeedbackError(null);
        }}
        feedbackError={feedbackError}
        armedId={armedId}
        pendingId={
          actionMutation.isPending
            ? (actionMutation.variables?.id ?? null)
            : null
        }
        onAction={onAction}
        onDecline={() => openModal("decline")}
        onQuestions={() => openModal("questions")}
      />
    );
  };

  return (
    <>
      <ReviewFrame>{body()}</ReviewFrame>
      {modal && (
        <RecipientActionModal
          kind={modal}
          value={modalText}
          onChange={(v) => {
            setModalText(v);
            if (modalError) setModalError(null);
          }}
          onSubmit={submitModal}
          onClose={closeModal}
          pending={modalPending}
          error={modalError}
        />
      )}
    </>
  );
}
