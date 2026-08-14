/**
 * Export — a complete, READ ONLY projection of the template.
 *
 * It emits exactly what `PUT /api/v1/templates/:id` accepts, including the keys
 * the old read-only JSON view dropped (`options`, `instructions`, the timeout
 * pair, `enable_review_links`, `chain_config`).
 *
 * It is not editable, and that is the ruling rather than an omission. An
 * editable JSON tab would be the one screen where every roadmap axis was
 * settable, which is precisely the accidental surface the tiering exists to
 * close. The declared escape hatch is the API, which is what the roadmap tier
 * already promises. The old editable branch also lied: it read six keys and
 * silently erased anything else on the next keystroke that parsed.
 *
 * Collapsed by default, like the prototype's JSON disclosure. "Show" now opens
 * the JSON in the app's shared Modal (`~/components/Modal`, the same chrome
 * FieldModal and ActionModal use) rather than an inline `<pre>` in the middle
 * of the editor. The `<pre>` block itself — class names, inline style, and the
 * `JSON.stringify(buildTemplateExport(template), null, 2)` call that produces
 * its content — is untouched, so what a reader sees is byte identical to
 * before; only the surface it renders on moved.
 *
 * Scrolling: Modal.tsx's dialog element is already `overflowY: "auto"` with a
 * `maxHeight: "85vh"` (Modal.tsx line ~61), so a long export scrolls the
 * modal's own body rather than the page behind it, for free — no extra
 * container needed. The scrollbar-reveal rule (tokens.css's
 * `::-webkit-scrollbar` + `[data-gw-scrolling]`, stamped by
 * theme/scroll-reveal.ts's document-level capture listener on whatever
 * element is actually scrolling) applies the same way it does to every other
 * `overflow-y-auto`/`overflow-x-auto` container in the app — TagInput.tsx's
 * chip row cites the identical mechanism.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { TemplateSchema } from "@gatewerk/shared";
import { buildTemplateExport } from "@gatewerk/web-core/state/templates/detail/template-export";
import { Modal } from "~/components/Modal";
import { SectionHeader } from "../_ui";

export function ExportSection({ template }: { template: TemplateSchema }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const json = JSON.stringify(buildTemplateExport(template), null, 2);

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is permission gated and can simply refuse. The text is on
      // screen and selectable, so there is nothing to recover from and nothing
      // worth interrupting the operator about.
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        label="Export"
        right={
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="gw-focus-ring cursor-pointer border-none bg-transparent text-[11.5px] font-medium transition-colors"
            style={{ color: "var(--gw-t7)" }}
          >
            Show
          </button>
        }
      />

      {open && (
        <Modal onClose={() => setOpen(false)} ariaLabel="Export" width={640}>
          {/* ExportSection is the deliberate exception left with an in-body
              header: its header carries a right-side Copy control that
              Modal's string title/subtitle slots cannot hold, so this stays
              hand-rolled while every other Modal consumer uses those slots.
              The Copy control itself is carried over unchanged from this
              file's old header slot. */}
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 className="font-display text-[16px] font-semibold" style={{ color: "var(--gw-t1)" }}>
                Export
              </h2>
              <p className="text-[12px] leading-relaxed" style={{ color: "var(--gw-t6)" }}>
                Exactly what PUT /api/v1/templates/:id accepts.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void copy()}
              className="gw-focus-ring flex shrink-0 cursor-pointer items-center gap-1.5 border-none bg-transparent text-[11.5px] font-medium transition-colors"
              style={{ color: copied ? "var(--gw-green-t)" : "var(--gw-t7)" }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <pre
            className="overflow-x-auto rounded-[11px] px-4 py-3.5 font-mono text-[11.5px] leading-[1.55]"
            style={{
              background: "var(--gw-inset)",
              border: "1px solid rgba(var(--gw-line-rgb),.08)",
              color: "var(--gw-t5)",
              whiteSpace: "pre-wrap",
            }}
          >
            {json}
          </pre>
        </Modal>
      )}
    </section>
  );
}
