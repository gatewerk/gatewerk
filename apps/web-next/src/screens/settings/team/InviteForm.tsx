/**
 * Invite-member form: email + role, Cancel/Generate link. Deliberately
 * smaller than ApiKeyForm/WebhookForm (two fields, no sections) — modeled
 * on their Cancel/primary-action footer only.
 */
import { Loader2 } from "lucide-react";
import { Field } from "../../../components/field/Field";
import { TextInput } from "../../../components/field/inputs";
import { GhostButton, PrimaryButton, SelectMenu } from "../../templates/_ui";
import { ROLE_OPTIONS } from "./team-logic";

interface InviteFormProps {
  email: string;
  role: string;
  onEmailChange: (v: string) => void;
  onRoleChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}

export function InviteForm({
  email,
  role,
  onEmailChange,
  onRoleChange,
  onCancel,
  onSubmit,
  isSubmitting,
}: InviteFormProps) {
  const canSubmit = email.trim().length > 0 && !isSubmitting;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-3">
        <Field label="Email">
          <TextInput
            type="email"
            autoFocus
            required
            autoComplete="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="jane@company.com"
          />
        </Field>

        <div className="flex items-center gap-3">
          <label className="text-[11.5px] font-medium" style={{ color: "var(--gw-t6)" }}>
            Role
          </label>
          <SelectMenu value={role} options={ROLE_OPTIONS} onChange={onRoleChange} ariaLabel="Invite role" minWidth={140} />
        </div>

        <span className="text-[11px]" style={{ color: "var(--gw-t8)" }}>
          Expires in 7 days.
        </span>
      </div>

      <div className="flex justify-end gap-2">
        <GhostButton onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </GhostButton>
        <PrimaryButton onClick={onSubmit} disabled={!canSubmit}>
          {isSubmitting && <Loader2 size={12} className="mr-1.5 animate-spin" />}
          Generate link
        </PrimaryButton>
      </div>
    </div>
  );
}
