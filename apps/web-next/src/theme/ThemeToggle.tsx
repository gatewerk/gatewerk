import { Sun, Moon } from "lucide-react";
import { IconButton } from "~/components/buttons";
import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
  const { resolved, setPref } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <IconButton title={`Switch to ${next} theme`} onClick={() => setPref(next)} size={34} radius={9}>
      {/* Icon shows the theme you SWITCH TO (prototype: dark → sun) */}
      {resolved === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </IconButton>
  );
}
