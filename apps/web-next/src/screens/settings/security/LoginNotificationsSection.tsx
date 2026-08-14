/**
 * Login notifications — the prototype's Security card (manifest S9.3): bell
 * icon + title, the setting line + hint, neutral toggle right. Copy is the
 * prototype's own, superseding the NotificationsPane strings
 * this section originally carried.
 *
 * Data: GET/PUT /api/v1/auth/preferences via ~/api/preferences, same
 * ["preferences"] query key NotificationsPane uses, so the two stay in sync.
 */
import { Bell } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getPreferences, updatePreferences } from "~/api/preferences";
import { CARD_SHELL } from "../_shared/ui";
import { Toggle } from "../_shared/Toggle";

export function LoginNotificationsSection() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["preferences"],
    queryFn: getPreferences,
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (login_notifications: boolean) => updatePreferences({ login_notifications }),
    onSuccess: (_result, login_notifications) => {
      void queryClient.invalidateQueries({ queryKey: ["preferences"] });
      toast.success(login_notifications ? "Login notifications enabled" : "Login notifications disabled");
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Could not save preferences");
    },
  });

  // Opt-in by default while the server response is in flight.
  const enabled = data?.login_notifications ?? true;

  return (
    <div style={CARD_SHELL}>
      <div className="flex items-center gap-[11px]">
        <Bell size={15} strokeWidth={1.7} className="shrink-0" style={{ color: "var(--gw-t6)" }} />
        <span className="text-[14px] font-semibold" style={{ color: "var(--gw-t2)" }}>
          Login notifications
        </span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]" style={{ color: "var(--gw-t3)" }}>
            Email me when a new device signs in
          </div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--gw-t7)" }}>
            Get an alert whenever your account is accessed from a new location or device.
          </div>
        </div>
        <Toggle
          checked={enabled}
          onChange={(v) => mutation.mutate(v)}
          disabled={mutation.isPending}
          aria-label="Login notifications"
        />
      </div>
    </div>
  );
}
