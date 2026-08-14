import { useState, useEffect } from "react";

/**
 * Hook for animated mount/unmount of elements like dropdowns, popovers, modals.
 * Keeps the element mounted during exit animation, then unmounts after completion.
 *
 * Usage:
 *   const { mounted, entering, onAnimationEnd } = useAnimatedPresence(open);
 *   if (!mounted) return null;
 *   return <div className={entering ? "animate-fade-in" : "animate-fade-out"} onAnimationEnd={onAnimationEnd}>
 */
export function useAnimatedPresence(open: boolean) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  const onAnimationEnd = () => {
    if (!open) setMounted(false);
  };

  return {
    /** Whether the element should be in the DOM */
    mounted,
    /** True when entering (open), false when exiting (closing) */
    entering: open,
    /** Attach to the animated element's onAnimationEnd */
    onAnimationEnd,
  };
}
