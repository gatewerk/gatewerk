import { Modal } from "../Modal";

const GITHUB_ISSUES_URL = "https://github.com/gatewerk/gatewerk/issues";

const LINK_CLS =
  "flex items-center justify-center rounded-[9px] px-[11px] py-[9px] text-[13.5px] font-medium text-t3 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t1";

export function ProductFeedbackModalOss({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} ariaLabel="Send feedback" title="Send feedback" width={380}>
      <p className="text-[13px] leading-relaxed text-t6">
        Bug, idea, or anything else? A human reads every one:
      </p>
      <div className="flex flex-col gap-2">
        <a
          href={GITHUB_ISSUES_URL}
          target="_blank"
          rel="noreferrer"
          className={LINK_CLS}
          style={{ border: "1px solid rgba(var(--gw-line-rgb),.14)" }}
        >
          Open a GitHub issue
        </a>
        <a
          href="mailto:hello@gatewerk.com"
          className={LINK_CLS}
          style={{ border: "1px solid rgba(var(--gw-line-rgb),.14)" }}
        >
          Email hello@gatewerk.com
        </a>
      </div>
    </Modal>
  );
}
