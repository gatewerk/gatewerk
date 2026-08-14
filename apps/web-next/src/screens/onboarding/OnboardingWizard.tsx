/**
 * Cloud activation wizard — route `/onboarding`.
 *
 * This is the destination all three cloud signup paths already navigate to
 * (ee/auth/CloudSignup.tsx:101, OAuthCallback.tsx:40, AuthConfirm.tsx:70).
 * Until it existed, every new cloud user landed on NotFound.
 *
 * Three steps, and the design's grammar throughout: WAITING → LISTENING → first
 * review. The handoff renders the wizard as a glass overlay on a live inbox so
 * step 3 can dissolve into the inbox empty state; it explicitly permits a
 * standalone route provided the listening visuals match, which they do — step 3
 * and the inbox Tier-1 render the same EmptyStateCore and the same StatusPill,
 * so the hand-off reads as one surface rather than a cut.
 *
 * Differences from apps/web's wizard, each deliberate:
 *
 *  - Step 1 SAVES the project name. apps/web collected it into local state and
 *    threw it away, while its own subtitle promised "you can rename it later in
 *    Settings" — a rename of something never named. PUT /settings/project has
 *    accepted `name` all along.
 *  - Step 2 resolves a template slug that actually exists, and offers to create
 *    a starter one when the project has none. Cloud provisioning creates a
 *    reviewer, org, project and API key but NO templates
 *    (apps/api/ee/auth/provision.ts), and reviews.create rejects an unknown
 *    template — so without this the snippet on the very next line 422s and the
 *    step-3 poll waits forever on a review that could never arrive.
 *  - Every step is skippable, and skipping is not failure: finish() marks
 *    onboarding complete and goes to the inbox, which is where the OSS
 *    activation empty state picks the user up.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, Inbox as InboxIcon, FileText } from "lucide-react";
import { toast } from "sonner";
import { request } from "@gatewerk/web-core/api/client/http";
import { apiKeys } from "@gatewerk/web-core/api/api-keys";
import { templates } from "@gatewerk/web-core/api/templates";
import { getProjectSettings, updateProjectSettingsMutation } from "@gatewerk/web-core/api/projects";
import { EmptyStateCore, StatusPill } from "~/components/empty-state";
import { isOnboardingComplete, markOnboardingComplete } from "./onboarding-store";
import { CodeSnippet } from "./CodeSnippet";
import { WizardShell } from "./WizardShell";

// The wizard's own starter template. Two fields, because one field is not a
// review and five is a form to fill in before anything works.
const STARTER_TEMPLATE = {
  slug: "first-review",
  name: "First review",
  description: "Created during setup. Rename or replace it whenever you like.",
  fields: [
    { name: "summary", type: "text" as const, label: "Summary", editable: true },
    { name: "detail", type: "markdown" as const, label: "Detail", editable: true },
  ],
};

function StepHeading({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <div
        className="font-display text-[15px] font-semibold text-t1"
        style={{ letterSpacing: "-.01em" }}
      >
        {title}
      </div>
      <div className="text-[12.5px] text-t5" style={{ lineHeight: 1.5 }}>
        {body}
      </div>
    </div>
  );
}

function Mono({ children }: { children: string }) {
  return (
    <span className="font-mono text-t4" style={{ fontSize: "0.94em" }}>
      {children}
    </span>
  );
}

// ── Step 1 — name the project ────────────────────────────────────────────────

function Step1({ name, onName }: { name: string; onName: (v: string) => void }) {
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <StepHeading
        title="Name your project"
        body="A project groups your templates, keys, and reviews. You can rename it later in Settings."
      />
      <input
        type="text"
        value={name}
        autoFocus
        onChange={(e) => onName(e.target.value)}
        placeholder="Production"
        aria-label="Project name"
        className="gw-focus-ring"
        style={{
          height: 42,
          width: "100%",
          borderRadius: 11,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "rgba(var(--gw-line-rgb),.12)",
          background: "var(--gw-inset)",
          padding: "0 14px",
          fontFamily: "inherit",
          fontSize: 13.5,
          color: "var(--gw-t1)",
          outline: "none",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
}

// ── Step 2 — key + template + snippet ────────────────────────────────────────

function Step2({
  apiKey,
  onApiKey,
  templateSlug,
  onTemplateSlug,
  templatesLoading,
}: {
  apiKey: string;
  onApiKey: (v: string) => void;
  templateSlug: string;
  onTemplateSlug: (v: string) => void;
  templatesLoading: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      toast.success("API key copied");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      // Scoped to exactly what an agent sending its first review needs. A key
      // handed out during setup should not also be able to decide reviews.
      const result = await apiKeys.create({
        name: "Onboarding",
        scopes: ["reviews:create", "reviews:read"],
      });
      onApiKey(result.raw_key);
      toast.success("API key generated");
    } catch {
      toast.error("Could not generate an API key");
    } finally {
      setGenerating(false);
    }
  }

  async function handleCreateTemplate() {
    setCreatingTemplate(true);
    try {
      const created = await templates.create(STARTER_TEMPLATE);
      onTemplateSlug(created.slug);
      toast.success("Starter template created");
    } catch {
      toast.error("Could not create the starter template");
    } finally {
      setCreatingTemplate(false);
    }
  }

  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      <StepHeading
        title="Your API key"
        body="Authenticate your agent, then send a review with the SDK. Keep this secret."
      />

      {apiKey ? (
        <div className="flex flex-col" style={{ gap: 7 }}>
          <div
            className="flex items-center"
            style={{
              gap: 10,
              borderRadius: 11,
              background: "var(--gw-inset)",
              border: "1px solid rgba(var(--gw-line-rgb),.09)",
              padding: "10px 12px",
            }}
          >
            <code
              className="min-w-0 flex-1 truncate font-mono text-[12px]"
              style={{ color: "var(--gw-t3)" }}
            >
              {apiKey}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy API key"
              className="gw-focus-ring flex shrink-0 cursor-pointer items-center rounded-[7px] border-none bg-transparent"
              style={{ gap: 5, padding: "4px 8px", fontSize: 11, fontWeight: 500, color: copied ? "var(--gw-green-t)" : "var(--gw-t7)" }}
            >
              {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.9} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-[11.5px] text-t7" style={{ margin: 0 }}>
            This is the only time the key is shown. You can manage keys in Settings.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating}
          className="gw-focus-ring flex h-10 w-full cursor-pointer items-center justify-center rounded-[10px] text-[12.5px] font-medium transition-colors"
          style={{
            gap: 8,
            border: "1px solid rgba(var(--gw-line-rgb),.12)",
            background: "var(--gw-inset-soft)",
            color: "var(--gw-t4)",
            opacity: generating ? 0.6 : 1,
          }}
        >
          {generating ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
          {generating ? "Generating" : "Generate a key"}
        </button>
      )}

      {/* A snippet naming a template the project does not have is a snippet that
          422s. Offer the template before the code that needs it. */}
      {!templatesLoading && !templateSlug && (
        <button
          type="button"
          onClick={handleCreateTemplate}
          disabled={creatingTemplate}
          className="gw-focus-ring flex h-10 w-full cursor-pointer items-center justify-center rounded-[10px] text-[12.5px] font-medium transition-colors"
          style={{
            gap: 8,
            border: "1px solid rgba(var(--gw-line-rgb),.12)",
            background: "var(--gw-inset-soft)",
            color: "var(--gw-t4)",
            opacity: creatingTemplate ? 0.6 : 1,
          }}
        >
          {creatingTemplate ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
          {creatingTemplate ? "Creating" : "Create a starter template"}
        </button>
      )}

      <CodeSnippet apiKey={apiKey} templateSlug={templateSlug} />
    </div>
  );
}

// ── Step 3 — listening ───────────────────────────────────────────────────────

function Step3({ project, received }: { project: string; received: boolean }) {
  return (
    <div className="flex flex-col items-center text-center" style={{ gap: 14, padding: "10px 0 4px" }}>
      <EmptyStateCore
        ring="live"
        tone="green"
        size={52}
        icon={<InboxIcon size={22} strokeWidth={1.6} />}
      />
      <div className="flex flex-col" style={{ gap: 6 }}>
        <div
          className="font-display text-[16px] font-semibold text-t1"
          style={{ letterSpacing: "-.01em" }}
        >
          {received ? "First review received" : `${project} is listening`}
        </div>
        <div className="text-[12.5px] text-t5" style={{ lineHeight: 1.5, maxWidth: 320 }}>
          {received ? (
            "Your agent is connected. It is waiting in your inbox."
          ) : (
            <>
              Run your agent. Its first <Mono>reviews.create</Mono> lands in your inbox, ready to
              decide.
            </>
          )}
        </div>
      </div>
      <StatusPill variant="live" label={received ? "Connected" : "Listening"} />
    </div>
  );
}

// ── Wizard ───────────────────────────────────────────────────────────────────

export default function OnboardingWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  // NOT seeded from `?api_key=`, which is what apps/web did. Nothing populates
  // that parameter — provisioning returns the raw key in a JSON body and all
  // three cloud redirects go to a bare /onboarding — so the read was a
  // secret-bearing URL channel with no writer. A key in a URL lands in browser
  // history, in referrers, and in whatever the monitoring layer captures:
  // PostHog runs capture_pageview, and ee/monitoring/redact.ts scrubs by
  // parameter NAME, which did not include this one. That is the same shape as
  // the token_hash leak lane A1 closed. The generate-key fallback below is the
  // real path.
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [received, setReceived] = useState(false);
  const [templateSlug, setTemplateSlug] = useState("");

  const { data: project } = useQuery({
    queryKey: ["settings", "project"],
    queryFn: () => getProjectSettings.run({}),
    staleTime: 60_000,
  });

  const { data: templateList, isLoading: templatesLoading } = useQuery({
    queryKey: ["templates", "list"],
    queryFn: () => templates.list(),
    staleTime: 60_000,
  });

  useEffect(() => {
    document.title = "Set up Gatewerk";
  }, []);

  // Seed from the real project rather than a hardcoded "My Project": an admin
  // who already named it should see their name, not be asked to invent another.
  useEffect(() => {
    if (project?.name) setName((prev) => (prev === "" ? project.name : prev));
  }, [project?.name]);

  useEffect(() => {
    const first = templateList?.items?.[0]?.slug;
    if (first) setTemplateSlug((prev) => (prev === "" ? first : prev));
  }, [templateList]);

  useEffect(() => {
    if (isOnboardingComplete()) navigate("/", { replace: true });
    // Intentionally mount-only: this is a "have you been here before" check, not
    // a subscription. Re-running it on every render would fight finish().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 3's poll — the genuine loop-closing signal. Runs only while the step is
  // mounted and stops the moment a review lands.
  useEffect(() => {
    if (step !== 2 || received) return;
    const id = setInterval(() => {
      request<{ total: number }>("/api/v1/reviews?limit=1")
        .then((res) => {
          if (res.total > 0) setReceived(true);
        })
        .catch(() => {
          // Silent by design. A transient poll failure is not news the admin
          // can act on, and an error banner under a "listening" heading reads
          // as though the setup itself broke.
        });
    }, 3000);
    return () => clearInterval(id);
  }, [step, received]);

  function finish() {
    markOnboardingComplete();
    navigate("/", { replace: true });
  }

  async function saveNameThenAdvance() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== project?.name) {
      setSavingName(true);
      try {
        await updateProjectSettingsMutation({ name: trimmed });
      } catch {
        // Never block on this. The admin came here to connect an agent, and a
        // project they could not rename is a smaller problem than a wizard they
        // cannot leave.
        toast.error("Could not save the project name");
      } finally {
        setSavingName(false);
      }
    }
    setStep(1);
  }

  const projectLabel = name.trim() || project?.name || "Your project";

  if (step === 0) {
    return (
      <WizardShell
        step={0}
        primaryLabel="Continue"
        primaryDisabled={savingName}
        onPrimary={() => void saveNameThenAdvance()}
        onSkip={finish}
      >
        <Step1 name={name} onName={setName} />
      </WizardShell>
    );
  }

  if (step === 1) {
    return (
      <WizardShell step={1} primaryLabel="Continue" onPrimary={() => setStep(2)} onSkip={finish}>
        <Step2
          apiKey={apiKey}
          onApiKey={setApiKey}
          templateSlug={templateSlug}
          onTemplateSlug={setTemplateSlug}
          templatesLoading={templatesLoading}
        />
      </WizardShell>
    );
  }

  return (
    <WizardShell step={2} primaryLabel="Enter inbox" onPrimary={finish} onSkip={finish}>
      <Step3 project={projectLabel} received={received} />
    </WizardShell>
  );
}
