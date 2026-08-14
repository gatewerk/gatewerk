export const ID_PREFIXES = {
  review: "gw_rev_",
  template: "gw_tpl_",
  project: "gw_prj_",
  api_key: "gw_key_",
  webhook: "gw_wh_",
  event: "gw_evt_",
  user: "gw_usr_",
  version: "gw_ver_",
  delivery: "gw_del_",
  token: "gw_tok_",
  invite: "gw_inv_",
  note: "gw_nt_",
  org: "gw_org_",
  omem: "gw_omem_",
  chain_run: "gw_chain_",
  chain_step: "gw_step_",
  pin: "gw_pin_",
  session: "gw_sess_",
  csub: "gw_csub_",
  swevt: "gw_swevt_",
  uevt: "gw_uevt_",
  urol: "gw_urol_",
  tomb: "gw_tomb_",
  passkey: "gw_pkey_",
  meterq: "gw_meterq_",
  notification: "gw_notif_",
  suppression: "gw_supp_",
  email_send: "gw_esnd_",
  product_feedback: "gw_pfb_",
} as const;

export type ResourceType = keyof typeof ID_PREFIXES;

const RANDOM_BYTES = 18; // 18 bytes = 24 base64url chars

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "").slice(0, 24);
}

export function generateId(type: ResourceType): string {
  const prefix = ID_PREFIXES[type];
  const bytes = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return `${prefix}${toBase64Url(bytes)}`;
}

const REVERSE_PREFIXES = Object.fromEntries(
  Object.entries(ID_PREFIXES).map(([type, prefix]) => [prefix, type])
) as Record<string, ResourceType>;

export function parseId(id: string): { type: ResourceType; prefix: string; random: string } | null {
  if (!id || typeof id !== "string") return null;

  for (const [prefix, type] of Object.entries(REVERSE_PREFIXES)) {
    if (id.startsWith(prefix)) {
      const random = id.slice(prefix.length);
      if (random.length > 0) {
        return { type, prefix, random };
      }
    }
  }
  return null;
}

export function isValidId(id: string, expectedType: ResourceType): boolean {
  const parsed = parseId(id);
  return parsed !== null && parsed.type === expectedType;
}
