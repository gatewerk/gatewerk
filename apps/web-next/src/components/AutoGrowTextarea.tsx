/**
 * AutoGrowTextarea — a <textarea> that grows its own height to fit its
 * content instead of scrolling internally. Classic scrollHeight technique:
 * reset height to "auto" so scrollHeight reports the content's real height,
 * then set height to that value. Runs on every value change, including
 * external ones (e.g. the field being cleared after submit).
 *
 * No dependency, no max-height/scroll fallback — the ask this exists for is
 * "no scrollbar," not "no scrollbar until N lines." resize is forced off:
 * a manual resize handle on an auto-growing field fights the auto-grow
 * effect on the very next keystroke.
 */
import { forwardRef, useEffect, useRef, type TextareaHTMLAttributes } from "react";

function setRef<T>(ref: React.Ref<T> | undefined, node: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(node);
  else (ref as React.MutableRefObject<T | null>).current = node;
}

export const AutoGrowTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function AutoGrowTextarea({ value, rows = 1, style, ...props }, forwardedRef) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={(node) => {
        innerRef.current = node;
        setRef(forwardedRef, node);
      }}
      value={value}
      rows={rows}
      style={{ ...style, resize: "none", overflow: "hidden" }}
      {...props}
    />
  );
});
