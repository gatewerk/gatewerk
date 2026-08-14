#!/usr/bin/env node
/**
 * audit-surface — surface inventory generator.
 *
 * Enumerates the backend's full UI-relevant surface from machine-readable
 * sources and emits a human-readable inventory (for designers) and a
 * machine-readable inventory.
 *
 * Principle: DERIVE from live exports — never hardcode values that exist
 * in source. Run via `pnpm audit:surface` or `bun scripts/audit-surface.mjs`.
 *
 * The inventory sections are advisory. Section 8 is NOT: the surface-tier gate
 * exits 1 when a live schema carries a configuration axis that
 * packages/shared/src/surface-tiers/ does not classify. Adding a knob stops the
 * build until someone decides whether users ever see it.
 */
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GENERATED_DIR = join(REPO_ROOT, "docs", "generated");
const REGEN_CMD = "pnpm audit:surface";
const SOURCES = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rel(abs) {
  return relative(REPO_ROOT, abs);
}

function bullet(values) {
  return values.join(" · ");
}

function mdTable(headers, rows) {
  const cols = headers.length;
  const lines = [];
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("| " + headers.map(() => "---").join(" | ") + " |");
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : headers.map((_, i) => String(row[i] ?? ""));
    lines.push("| " + cells.map((c) => String(c ?? "").replace(/\|/g, "\\|")).join(" | ") + " |");
  }
  return lines.join("\n");
}

function truncate(s, n = 80) {
  if (!s) return "";
  s = String(s).replace(/\n/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// 1. Import shared enums (with per-module try/catch)
// ---------------------------------------------------------------------------

const sharedBase = join(REPO_ROOT, "packages", "shared", "src");
const importFailures = [];

async function tryImport(label, specifier) {
  try {
    const mod = await import(specifier);
    SOURCES.push(label);
    return mod;
  } catch (err) {
    importFailures.push({ label, err: err.message ?? String(err) });
    return {};
  }
}

const enumsMod = await tryImport(
  "packages/shared/src/enums.ts",
  join(sharedBase, "enums.ts")
);
const indexMod = await tryImport(
  "packages/shared/src/index.ts",
  join(sharedBase, "index.ts")
);
const entitlementsMod = await tryImport(
  "packages/shared/src/entitlements.ts",
  join(sharedBase, "entitlements.ts")
);
const cloudMod = await tryImport(
  "packages/shared/src/cloud.ts",
  join(sharedBase, "cloud.ts")
);
const idsMod = await tryImport(
  "packages/shared/src/ids.ts",
  join(sharedBase, "ids.ts")
);
const webhooksMod = await tryImport(
  "packages/shared/src/api/schemas/webhooks.ts",
  join(sharedBase, "api", "schemas", "webhooks.ts")
);
const templatesMod = await tryImport(
  "packages/shared/src/api/schemas/templates.ts",
  join(sharedBase, "api", "schemas", "templates.ts")
);

// Request-body schemas backing the surface-tier gate (§8).
const reviewsMod = await tryImport(
  "packages/shared/src/api/schemas/reviews.ts",
  join(sharedBase, "api", "schemas", "reviews.ts")
);
const chainsMod = await tryImport(
  "packages/shared/src/api/schemas/chains.ts",
  join(sharedBase, "api", "schemas", "chains.ts")
);
const notesMod = await tryImport(
  "packages/shared/src/api/schemas/notes.ts",
  join(sharedBase, "api", "schemas", "notes.ts")
);
const teamMod = await tryImport(
  "packages/shared/src/api/schemas/notifications.ts",
  join(sharedBase, "api", "schemas", "notifications.ts")
);
const notifPrefsMod = await tryImport(
  "packages/shared/src/api/schemas/notification-prefs.ts",
  join(sharedBase, "api", "schemas", "notification-prefs.ts")
);
const apiKeysMod = await tryImport(
  "packages/shared/src/api/schemas/api-keys.ts",
  join(sharedBase, "api", "schemas", "api-keys.ts")
);
const projectsMod = await tryImport(
  "packages/shared/src/api/schemas/projects.ts",
  join(sharedBase, "api", "schemas", "projects.ts")
);

// Destructure enums (fall back to empty arrays on missing)
const {
  PRIORITIES = [],
  DECISIONS = [],
  REVIEW_STATUSES = [],
  NON_TERMINAL_REVIEW_STATUSES = [],
  TERMINAL_REVIEW_STATUSES = [],
  DEPRECATED_REVIEW_STATUSES = [],
  ACTION_KINDS = [],
  DECISION_VALUES = [],
  TRIGGER_PATHS = [],
  IRREVERSIBILITY = [],
  TIMEOUT_ACTIONS = [],
  OVERSIGHT_MODES = [],
  FIELD_TYPES = [],
  SCOPES = [],
} = enumsMod;

const {
  ACTION_TYPES = [],
  AUDIT_ACTIONS = [],
  NOTIFICATION_EVENTS = [],
  SCOPE_PRESETS = {},
  SCOPE_LABELS = {},
  TEMPLATE_STATUSES = [],
  GATEWERK_MODES = [],
  ORG_ROLES = [],
} = indexMod;

const { ENTITLEMENT_KEYS = [], PLAN_IDS = [], PLAN_ENTITLEMENTS = {} } = entitlementsMod;
const { SUBSCRIPTION_PLANS = [], SUBSCRIPTION_STATUSES = [], PLAN_LIMITS = {} } = cloudMod;
const { ID_PREFIXES = {} } = idsMod;
const { NOTIFICATION_CHANNEL_TYPES = [] } = webhooksMod;
const { TemplateObjectSchema } = templatesMod;

// ---------------------------------------------------------------------------
// 2. OpenAPI snapshot
// ---------------------------------------------------------------------------

const snapshotPath = join(
  REPO_ROOT,
  "apps", "api", "src", "openapi", "__snapshots__", "openapi.snapshot.json"
);
SOURCES.push(rel(snapshotPath));

let openApiOps = [];
let openApiSchemas = [];
let apiCounts = { paths: 0, operations: 0, schemas: 0 };

try {
  const raw = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const paths = raw.paths ?? {};
  apiCounts.paths = Object.keys(paths).length;

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (typeof op !== "object" || op === null) continue;
      const httpMethods = ["get","post","put","patch","delete","head","options","trace"];
      if (!httpMethods.includes(method.toLowerCase())) continue;
      openApiOps.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId ?? "",
        summary: truncate(op.summary ?? op.description ?? "", 80),
        tags: (op.tags ?? []).join(", "),
      });
      apiCounts.operations++;
    }
  }

  const schemas = (raw.components ?? {}).schemas ?? {};
  openApiSchemas = Object.keys(schemas).sort();
  apiCounts.schemas = openApiSchemas.length;
} catch (err) {
  importFailures.push({ label: "openapi.snapshot.json", err: err.message ?? String(err) });
}

// ---------------------------------------------------------------------------
// 3. Template flags via Zod reflection
// ---------------------------------------------------------------------------

const templateFlags = [];

if (TemplateObjectSchema && typeof TemplateObjectSchema === "object") {
  try {
    const shape = TemplateObjectSchema.shape ?? {};
    for (const [key, raw] of Object.entries(shape)) {
      // Unwrap optional/nullable wrappers
      let def = raw;
      // Zod 4: unwrap optional/nullable via .unwrap() if available
      let unwrapped = def;
      try {
        // Keep unwrapping optionals and nullables
        let safety = 0;
        while (safety++ < 10) {
          const typeName = unwrapped?._zod?.def?.type ?? unwrapped?._def?.typeName ?? "";
          if (
            typeName === "ZodOptional" ||
            typeName === "optional" ||
            typeName === "ZodNullable" ||
            typeName === "nullable"
          ) {
            unwrapped = unwrapped.unwrap?.() ?? unwrapped._def?.innerType ?? unwrapped;
            break;
          } else {
            break;
          }
        }
      } catch {
        // keep unwrapped as-is
      }

      // Classify by duck-typing
      let kind = "unknown";
      let extra = "";

      try {
        // Zod 4 stores type info in _zod.def.type; Zod 3 uses _def.typeName
        const typeName4 = unwrapped?._zod?.def?.type ?? "";
        const typeName3 = unwrapped?._def?.typeName ?? "";
        const typeName = typeName4 || typeName3;

        if (typeName === "ZodBoolean" || typeName === "boolean") {
          kind = "flag";
        } else if (
          typeName === "ZodEnum" ||
          typeName === "enum" ||
          typeName === "ZodNativeEnum"
        ) {
          kind = "enum";
          const options =
            unwrapped?.options ??
            unwrapped?._def?.values ??
            Object.values(unwrapped?._def?.nativeEnum ?? {});
          if (Array.isArray(options) && options.length > 0) {
            extra = options.join(", ");
          } else if (options && typeof options === "object") {
            extra = Object.values(options).join(", ");
          }
        } else if (typeName === "ZodLiteral" || typeName === "literal") {
          kind = "literal";
          extra =
            String(unwrapped?._zod?.def?.value ?? unwrapped?._def?.value ?? "");
        } else if (typeName === "ZodString" || typeName === "string") {
          kind = "string";
        } else if (typeName === "ZodNumber" || typeName === "number") {
          kind = "number";
        } else if (typeName === "ZodArray" || typeName === "array") {
          kind = "array";
        } else if (typeName === "ZodObject" || typeName === "object") {
          kind = "object";
        } else if (typeName === "ZodRecord" || typeName === "record") {
          kind = "record";
        } else if (typeName === "ZodUnion" || typeName === "union") {
          kind = "union";
        } else if (typeName === "ZodNull" || typeName === "null") {
          kind = "null";
        } else if (typeName) {
          kind = typeName.replace(/^Zod/, "").toLowerCase();
        }
      } catch {
        kind = "unknown";
      }

      templateFlags.push({ field: key, kind, extra });
    }
  } catch (err) {
    importFailures.push({ label: "TemplateObjectSchema reflection", err: err.message ?? String(err) });
  }
}

// ---------------------------------------------------------------------------
// 4. Error-code scan (static regex over apps/api/src/**/*.ts)
// ---------------------------------------------------------------------------

const ERROR_CLASSES = [
  "InvalidRequest",
  "NotFound",
  "Conflict",
  "Authentication",
  "Forbidden",
  "Gone",
  "PayloadTooLarge",
];

// Constructor signatures (from packages/shared/src/errors.ts):
//   InvalidRequestError(message, param?, code = "invalid_request")  → code is 3rd arg
//   NotFoundError(message, code = "not_found")                       → code is 2nd arg
//   ConflictError(message, code = "conflict")                        → code is 2nd arg
//   AuthenticationError(message?, code = "authentication_error")     → code is 2nd arg
//   ForbiddenError(message?, code = "forbidden")                     → code is 2nd arg
//   GoneError(message, code = "gone")                                → code is 2nd arg
//   PayloadTooLargeError(message, code = "payload_too_large")        → code is 2nd arg
//
// For InvalidRequestError we need the 3rd arg (if present); for all others, 2nd arg.

// Pattern A: new <Class>Error("message", "param?", "code")  — InvalidRequestError with 3 args
const RE_INVALID_3 =
  /new\s+InvalidRequestError\s*\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*,\s*(?:"[^"]*"|'[^']*'|`[^`]*`|undefined|null)\s*,\s*["']([a-z0-9_.]+)["']/g;

// Pattern B: new <Class>Error("message", "code")  — 2-arg form for non-InvalidRequest errors
const RE_2ARG =
  /new\s+(NotFound|Conflict|Authentication|Forbidden|Gone|PayloadTooLarge)Error\s*\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*,\s*["']([a-z0-9_.]+)["']/g;

// Pattern C: new <Class>Error("code") — 1-arg form where first string is the code
// (AuthenticationError can be called with just code as first arg in some places)
const RE_1ARG_CODE =
  /new\s+(Authentication|Forbidden)Error\s*\(\s*["']([a-z0-9_.]+)["']\s*\)/g;

// Fallback: capture any string literal first arg (for message), noting default code
const RE_DEFAULT =
  /new\s+(InvalidRequest|NotFound|Conflict|Authentication|Forbidden|Gone|PayloadTooLarge)Error\s*\(/g;

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (
        name === "node_modules" || name === "dist" || name === "__tests__" ||
        name === "__snapshots__" || name === "build" || name === "coverage"
      ) continue;
      walkTs(full, out);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

const apiSrcDir = join(REPO_ROOT, "apps", "api", "src");
const tsFiles = walkTs(apiSrcDir);
SOURCES.push("apps/api/src/**/*.ts (error scan)");

// Map: code → { errorClass, files: Set<string> }
const errorCodeMap = new Map();

function recordCode(code, cls, filePath) {
  const relPath = rel(filePath);
  if (!errorCodeMap.has(code)) {
    errorCodeMap.set(code, { errorClass: cls + "Error", files: new Set() });
  }
  errorCodeMap.get(code).files.add(relPath);
}

for (const filePath of tsFiles) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }

  // Pattern A — InvalidRequestError 3rd-arg code
  for (const m of content.matchAll(RE_INVALID_3)) {
    recordCode(m[1], "InvalidRequest", filePath);
  }

  // Pattern B — 2-arg form (2nd arg is code)
  for (const m of content.matchAll(RE_2ARG)) {
    recordCode(m[2], m[1], filePath);
  }

  // Pattern C — 1-arg code (authentication/forbidden sometimes)
  for (const m of content.matchAll(RE_1ARG_CODE)) {
    // Heuristic: if the string looks like a code (snake_case) record it
    if (/^[a-z][a-z0-9_]*$/.test(m[2]) && m[2].includes("_")) {
      recordCode(m[2], m[1], filePath);
    }
  }
}

const errorCodes = Array.from(errorCodeMap.entries())
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, { errorClass, files }]) => ({
    code,
    errorClass,
    exampleFiles: Array.from(files).slice(0, 3),
  }));

// ---------------------------------------------------------------------------
// 5. Audit actions grouped by prefix
// ---------------------------------------------------------------------------

function groupByPrefix(actions) {
  const groups = {};
  for (const a of actions) {
    const prefix = a.includes(".") ? a.split(".")[0] : a;
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(a);
  }
  return groups;
}

const auditGroups = groupByPrefix(AUDIT_ACTIONS);

// ---------------------------------------------------------------------------
// 6. Assemble JSON output
// ---------------------------------------------------------------------------

const generatedAt = new Date().toISOString();

const enumsOut = {};
function addEnum(name, source, values) {
  enumsOut[name] = { source, values: Array.from(values) };
}

addEnum("PRIORITIES", "packages/shared/src/enums.ts", PRIORITIES);
addEnum("DECISIONS", "packages/shared/src/enums.ts", DECISIONS);
addEnum("REVIEW_STATUSES", "packages/shared/src/enums.ts", REVIEW_STATUSES);
addEnum("NON_TERMINAL_REVIEW_STATUSES", "packages/shared/src/enums.ts", NON_TERMINAL_REVIEW_STATUSES);
addEnum("TERMINAL_REVIEW_STATUSES", "packages/shared/src/enums.ts", TERMINAL_REVIEW_STATUSES);
addEnum("DEPRECATED_REVIEW_STATUSES", "packages/shared/src/enums.ts", DEPRECATED_REVIEW_STATUSES);
addEnum("ACTION_KINDS", "packages/shared/src/enums.ts", ACTION_KINDS);
addEnum("DECISION_VALUES", "packages/shared/src/enums.ts", DECISION_VALUES);
addEnum("TRIGGER_PATHS", "packages/shared/src/enums.ts", TRIGGER_PATHS);
addEnum("IRREVERSIBILITY", "packages/shared/src/enums.ts", IRREVERSIBILITY);
addEnum("TIMEOUT_ACTIONS", "packages/shared/src/enums.ts", TIMEOUT_ACTIONS);
addEnum("OVERSIGHT_MODES", "packages/shared/src/enums.ts", OVERSIGHT_MODES);
addEnum("FIELD_TYPES", "packages/shared/src/enums.ts", FIELD_TYPES);
addEnum("SCOPES", "packages/shared/src/enums.ts", SCOPES);
addEnum("ACTION_TYPES", "packages/shared/src/index.ts", ACTION_TYPES);
addEnum("AUDIT_ACTIONS", "packages/shared/src/index.ts", AUDIT_ACTIONS);
addEnum("NOTIFICATION_EVENTS", "packages/shared/src/index.ts", NOTIFICATION_EVENTS);
addEnum("TEMPLATE_STATUSES", "packages/shared/src/index.ts", TEMPLATE_STATUSES);
addEnum("GATEWERK_MODES", "packages/shared/src/index.ts", GATEWERK_MODES);
addEnum("ORG_ROLES", "packages/shared/src/index.ts", ORG_ROLES);
addEnum("ENTITLEMENT_KEYS", "packages/shared/src/entitlements.ts", ENTITLEMENT_KEYS);
addEnum("PLAN_IDS", "packages/shared/src/entitlements.ts", PLAN_IDS);
addEnum("SUBSCRIPTION_PLANS", "packages/shared/src/cloud.ts", SUBSCRIPTION_PLANS);
addEnum("SUBSCRIPTION_STATUSES", "packages/shared/src/cloud.ts", SUBSCRIPTION_STATUSES);
addEnum("NOTIFICATION_CHANNEL_TYPES", "packages/shared/src/api/schemas/webhooks.ts", NOTIFICATION_CHANNEL_TYPES);

const jsonOut = {
  generated_at: generatedAt,
  sources: SOURCES,
  import_failures: importFailures.length > 0 ? importFailures : undefined,
  enums: enumsOut,
  template_surface: {
    fields: templateFlags,
    statuses: Array.from(TEMPLATE_STATUSES),
    field_types: Array.from(FIELD_TYPES),
  },
  api: {
    counts: apiCounts,
    operations: openApiOps,
    schemas: openApiSchemas,
  },
  events: {
    notification_events: Array.from(NOTIFICATION_EVENTS),
    notification_channel_types: Array.from(NOTIFICATION_CHANNEL_TYPES),
    audit_actions: Array.from(AUDIT_ACTIONS),
    audit_actions_by_prefix: Object.fromEntries(
      Object.entries(auditGroups).map(([k, v]) => [k, v])
    ),
  },
  access: {
    scopes: Array.from(SCOPES),
    scope_labels: SCOPE_LABELS,
    scope_presets: Object.fromEntries(
      Object.entries(SCOPE_PRESETS).map(([k, v]) => [k, Array.from(v)])
    ),
    org_roles: Array.from(ORG_ROLES),
    gatewerk_modes: Array.from(GATEWERK_MODES),
  },
  plans: {
    plan_ids: Array.from(PLAN_IDS),
    entitlement_keys: Array.from(ENTITLEMENT_KEYS),
    plan_entitlements: PLAN_ENTITLEMENTS,
    subscription_plans: Array.from(SUBSCRIPTION_PLANS),
    subscription_statuses: Array.from(SUBSCRIPTION_STATUSES),
    plan_limits: PLAN_LIMITS,
  },
  id_prefixes: ID_PREFIXES,
  error_codes: errorCodes,
};

// ---------------------------------------------------------------------------
// 7. Assemble Markdown output
// ---------------------------------------------------------------------------

const lines = [];
const h = (level, text) => lines.push(`${"#".repeat(level)} ${text}`);
const blank = () => lines.push("");
const p = (text) => lines.push(text);
const li = (text) => lines.push(`- ${text}`);

h(1, "Gatewerk Surface Inventory (generated — do not edit)");
blank();
p(`> **Generated:** ${generatedAt}`);
p(`> **Regenerate:** \`${REGEN_CMD}\``);
blank();
p("**Sources:**");
for (const s of SOURCES) li(s);
if (importFailures.length > 0) {
  blank();
  p("**Import failures:**");
  for (const f of importFailures) li(`FAILED TO LOAD ${f.label}: ${f.err}`);
}

// ---------------------------------------------------------------------------
// §1 Review state machine
// ---------------------------------------------------------------------------
blank();
h(2, "1. Review state machine");
blank();

p(`**REVIEW_STATUSES** (packages/shared/src/enums.ts): ${bullet(REVIEW_STATUSES)}`);
p(`> UI must render ${REVIEW_STATUSES.length} distinct review states.`);
blank();

p(`**NON_TERMINAL_REVIEW_STATUSES** (packages/shared/src/enums.ts): ${bullet(NON_TERMINAL_REVIEW_STATUSES)}`);
p(`> UI must render ${NON_TERMINAL_REVIEW_STATUSES.length} non-terminal states (reviewer action pending or in-progress).`);
blank();

p(`**TERMINAL_REVIEW_STATUSES** (packages/shared/src/enums.ts): ${bullet(TERMINAL_REVIEW_STATUSES)}`);
p(`> UI must render ${TERMINAL_REVIEW_STATUSES.length} terminal states (review fully resolved).`);
blank();

p(`**DEPRECATED_REVIEW_STATUSES** (packages/shared/src/enums.ts): ${bullet(DEPRECATED_REVIEW_STATUSES)}`);
p(`> API filter-param alias only; removed in v2.0. UI should not surface these as states.`);
blank();

p(`**DECISIONS** (packages/shared/src/enums.ts): ${bullet(DECISIONS)}`);
p(`> UI must render ${DECISIONS.length} decision outcomes.`);
blank();

p(`**OVERSIGHT_MODES** (packages/shared/src/enums.ts): ${bullet(OVERSIGHT_MODES)}`);
p(`> UI must render ${OVERSIGHT_MODES.length} oversight modes (blocking = wait for human; monitoring = act immediately, human may veto).`);
blank();

p(`**IRREVERSIBILITY** (packages/shared/src/enums.ts): ${bullet(IRREVERSIBILITY)}`);
p(`> UI must render ${IRREVERSIBILITY.length} irreversibility tiers for confirmation dialogs.`);
blank();

p(`**TIMEOUT_ACTIONS** (packages/shared/src/enums.ts): ${bullet(TIMEOUT_ACTIONS)}`);
p(`> UI must render ${TIMEOUT_ACTIONS.length} timeout outcomes.`);
blank();

p(`**TRIGGER_PATHS** (packages/shared/src/enums.ts): ${bullet(TRIGGER_PATHS)}`);
p(`> UI must handle ${TRIGGER_PATHS.length} review creation paths.`);
blank();

p(`**PRIORITIES** (packages/shared/src/enums.ts): ${bullet(PRIORITIES)}`);
p(`> UI must render ${PRIORITIES.length} priority levels.`);

// ---------------------------------------------------------------------------
// §2 Actions
// ---------------------------------------------------------------------------
blank();
h(2, "2. Actions");
blank();

p(`**ACTION_KINDS** (packages/shared/src/enums.ts): ${bullet(ACTION_KINDS)}`);
p(`> Every template action belongs to one of ${ACTION_KINDS.length} kinds: decision (records approve/reject), iteration (requests changes), side_effect (triggers webhook without decision).`);
blank();

p(`**ACTION_TYPES** (packages/shared/src/index.ts): ${bullet(ACTION_TYPES)}`);
p(`> Legacy preset action type identifiers.`);
blank();

p(`**DECISION_VALUES** (packages/shared/src/enums.ts): ${bullet(DECISION_VALUES)}`);
p(`> Closed binary decision: ${DECISION_VALUES.length} values. Spec §6 rationale: audit fragmentation avoided by limiting to one approved and one rejected per template.`);

// ---------------------------------------------------------------------------
// §3 Template surface
// ---------------------------------------------------------------------------
blank();
h(2, "3. Template surface");
blank();

p(`**TEMPLATE_STATUSES** (packages/shared/src/index.ts): ${bullet(TEMPLATE_STATUSES)}`);
p(`> UI must render ${TEMPLATE_STATUSES.length} template lifecycle states.`);
blank();

p(`**FIELD_TYPES** (packages/shared/src/enums.ts): ${bullet(FIELD_TYPES)}`);
p(`> UI must render ${FIELD_TYPES.length} field type renderers.`);
blank();

if (templateFlags.length > 0) {
  p("**TemplateObjectSchema fields** (packages/shared/src/api/schemas/templates.ts — Zod reflection):");
  blank();
  const rows = templateFlags.map((f) => [f.field, f.kind, f.extra || ""]);
  p(mdTable(["field", "kind", "values / type"], rows));
} else {
  p("*TemplateObjectSchema reflection unavailable — see import_failures above.*");
}

// ---------------------------------------------------------------------------
// §4 API surface
// ---------------------------------------------------------------------------
blank();
h(2, "4. API surface");
blank();

p(`**Counts:** ${apiCounts.paths} paths · ${apiCounts.operations} operations · ${apiCounts.schemas} component schemas`);
blank();

if (openApiOps.length > 0) {
  const rows = openApiOps.map((op) => [op.method, op.path, op.operationId, op.summary]);
  p(mdTable(["METHOD", "path", "operationId", "summary"], rows));
} else {
  p("*OpenAPI snapshot unavailable — see import_failures above.*");
}

blank();
p("**Component schemas:**");
blank();
p(openApiSchemas.map((s) => `\`${s}\``).join(", "));

// ---------------------------------------------------------------------------
// §5 Events & channels
// ---------------------------------------------------------------------------
blank();
h(2, "5. Events and channels");
blank();

p(`**NOTIFICATION_EVENTS** (packages/shared/src/index.ts) — ${NOTIFICATION_EVENTS.length} events:`);
p(NOTIFICATION_EVENTS.map((e) => `\`${e}\``).join(", "));
blank();

p(`**NOTIFICATION_CHANNEL_TYPES** (packages/shared/src/api/schemas/webhooks.ts): ${bullet(NOTIFICATION_CHANNEL_TYPES)}`);
blank();

p(`**AUDIT_ACTIONS** (packages/shared/src/index.ts) — ${AUDIT_ACTIONS.length} total, grouped by prefix:`);
blank();

for (const [prefix, actions] of Object.entries(auditGroups)) {
  p(`_${prefix}_ (${actions.length}): ${actions.map((a) => `\`${a}\``).join(", ")}`);
  blank();
}

// ---------------------------------------------------------------------------
// §6 Access control
// ---------------------------------------------------------------------------
h(2, "6. Access control");
blank();

p(`**SCOPES** (packages/shared/src/enums.ts) — ${SCOPES.length} scopes:`);
blank();
const scopeRows = Array.from(SCOPES).map((s) => [s, SCOPE_LABELS[s] ?? ""]);
p(mdTable(["scope", "label"], scopeRows));
blank();

p("**SCOPE_PRESETS** (packages/shared/src/index.ts):");
blank();
for (const [preset, scopes] of Object.entries(SCOPE_PRESETS)) {
  p(`_${preset}_: ${bullet(scopes)}`);
}
blank();

p(`**ORG_ROLES** (packages/shared/src/index.ts): ${bullet(ORG_ROLES)}`);
p(`> UI must render ${ORG_ROLES.length} org roles.`);
blank();

p(`**GATEWERK_MODES** (packages/shared/src/index.ts): ${bullet(GATEWERK_MODES)}`);
p(`> UI must handle ${GATEWERK_MODES.length} deployment modes.`);

// ---------------------------------------------------------------------------
// §7 Plans & entitlements
// ---------------------------------------------------------------------------
blank();
h(2, "7. Plans and entitlements");
blank();

p(`**PLAN_IDS** (packages/shared/src/entitlements.ts): ${bullet(PLAN_IDS)}`);
blank();

p(`**ENTITLEMENT_KEYS** (packages/shared/src/entitlements.ts): ${bullet(ENTITLEMENT_KEYS)}`);
blank();

p("**PLAN_ENTITLEMENTS** (packages/shared/src/entitlements.ts) — expanded:");
blank();
for (const planId of PLAN_IDS) {
  const ents = PLAN_ENTITLEMENTS[planId] ?? [];
  if (ents.length === 0) {
    p(`_${planId}_: no entitlements (no feature walls)`);
  } else {
    p(`_${planId}_: ${ents.map((e) => `${e.key}=${e.value}`).join(", ")}`);
  }
}
blank();

p(`**SUBSCRIPTION_PLANS** (packages/shared/src/cloud.ts): ${bullet(SUBSCRIPTION_PLANS)}`);
blank();

p(`**SUBSCRIPTION_STATUSES** (packages/shared/src/cloud.ts): ${bullet(SUBSCRIPTION_STATUSES)}`);
blank();

p("**PLAN_LIMITS** (packages/shared/src/cloud.ts):");
blank();
const planLimitHeaders = ["plan", "name", "price (cents)", "trialDays", "reviewLimit", "templateLimit", "apiKeyLimit"];
const planLimitRows = Object.entries(PLAN_LIMITS).map(([plan, limits]) => [
  plan,
  limits.name,
  String(limits.price),
  String(limits.trialDays),
  limits.reviewLimit === Infinity ? "unlimited" : String(limits.reviewLimit),
  limits.templateLimit === Infinity ? "unlimited" : String(limits.templateLimit),
  limits.apiKeyLimit === Infinity ? "unlimited" : String(limits.apiKeyLimit),
]);
p(mdTable(planLimitHeaders, planLimitRows));

// ---------------------------------------------------------------------------
// §8 ID prefixes
// ---------------------------------------------------------------------------
blank();
h(2, "8. ID prefixes");
blank();

p("**ID_PREFIXES** (packages/shared/src/ids.ts):");
blank();
const idRows = Object.entries(ID_PREFIXES).map(([type, prefix]) => [type, prefix]);
p(mdTable(["resource type", "prefix"], idRows));

// ---------------------------------------------------------------------------
// §9 Error codes (scanned)
// ---------------------------------------------------------------------------
blank();
h(2, "9. Error codes (scanned)");
blank();

p("**Note:** extracted by static scan — no central registry exists (candidate hardening item).");
blank();

if (errorCodes.length > 0) {
  const errRows = errorCodes.map((e) => [
    e.code,
    e.errorClass,
    e.exampleFiles.join(", "),
  ]);
  p(mdTable(["code", "error class", "example locations (up to 3)"], errRows));
} else {
  p("*No error codes found by scan.*");
}

// ---------------------------------------------------------------------------
// §10 Designer coverage notes
// ---------------------------------------------------------------------------
blank();
h(2, "10. Designer coverage notes");
blank();

const coverageNotes = [
  [`REVIEW_STATUSES (${REVIEW_STATUSES.length})`, "Inbox · History · detail panel", REVIEW_STATUSES.length],
  [`NON_TERMINAL_REVIEW_STATUSES (${NON_TERMINAL_REVIEW_STATUSES.length})`, "Inbox · active queue badges", NON_TERMINAL_REVIEW_STATUSES.length],
  [`TERMINAL_REVIEW_STATUSES (${TERMINAL_REVIEW_STATUSES.length})`, "History · archive · completed states", TERMINAL_REVIEW_STATUSES.length],
  [`DECISIONS (${DECISIONS.length})`, "History · detail panel · decision badge", DECISIONS.length],
  [`OVERSIGHT_MODES (${OVERSIGHT_MODES.length})`, "Template editor · review detail · HOTL gate UI", OVERSIGHT_MODES.length],
  [`PRIORITIES (${PRIORITIES.length})`, "Inbox · review card · template editor", PRIORITIES.length],
  [`FIELD_TYPES (${FIELD_TYPES.length})`, "Template editor · review payload renderer · feedback", FIELD_TYPES.length],
  [`ACTION_KINDS (${ACTION_KINDS.length})`, "Action button group · template action editor", ACTION_KINDS.length],
  [`IRREVERSIBILITY (${IRREVERSIBILITY.length})`, "Confirmation dialog · review risk badge", IRREVERSIBILITY.length],
  [`TIMEOUT_ACTIONS (${TIMEOUT_ACTIONS.length})`, "Template editor timeout section · expired review states", TIMEOUT_ACTIONS.length],
  [`TEMPLATE_STATUSES (${TEMPLATE_STATUSES.length})`, "Templates list · template editor header", TEMPLATE_STATUSES.length],
  [`SCOPES (${SCOPES.length})`, "Connection editor · API key scope picker", SCOPES.length],
  [`ORG_ROLES (${ORG_ROLES.length})`, "Team settings · invite form · member list", ORG_ROLES.length],
  [`PLAN_IDS (${PLAN_IDS.length})`, "Billing settings · upgrade prompts · entitlement gates", PLAN_IDS.length],
  [`NOTIFICATION_CHANNEL_TYPES (${NOTIFICATION_CHANNEL_TYPES.length})`, "Webhook settings · channel type picker", NOTIFICATION_CHANNEL_TYPES.length],
];

for (const [enumName, surfaces, n] of coverageNotes) {
  p(`- **${enumName}** × ${surfaces} = **${n} states** each surface must handle.`);
}

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------

mkdirSync(GENERATED_DIR, { recursive: true });

const jsonPath = join(GENERATED_DIR, "surface-inventory.json");
const mdPath = join(GENERATED_DIR, "surface-inventory.md");

writeFileSync(jsonPath, JSON.stringify(jsonOut, (_, v) => (v === Infinity ? "Infinity" : v), 2), "utf8");
writeFileSync(mdPath, lines.join("\n") + "\n", "utf8");

// ---------------------------------------------------------------------------
// 8. Surface-tier gate
// ---------------------------------------------------------------------------
//
// The whole mechanism: add a knob, the build stops until someone decides where
// it lives. Everything above this line is advisory reporting; this section is
// the only part that can fail the process.
//
// Two failure classes, and a third that matters more than either:
//   UNDECLARED — a live schema carries an axis surface-tiers.ts does not
//                classify. This is the one that catches new knobs.
//   STALE      — surface-tiers.ts classifies an axis no live schema carries.
//                This catches a knob deleted without retiring its declaration,
//                which would otherwise leave a phantom line on the public
//                roadmap.
//   VACUOUS    — a source failed to load or reflected zero keys. Without this
//                check the gate would PASS on a broken import, which is the
//                precise shape of security theatre: green build, zero coverage.

const tierFailures = [];
const tierNotes = [];

let SURFACE_TIER_TABLES = null;
let allDeclaredAxes = null;
let controlGroupsOn = null;
let publicRoadmap = null;

{
  const mod = await tryImport(
    "packages/shared/src/surface-tiers/index.ts",
    join(sharedBase, "surface-tiers", "index.ts"),
  );
  SURFACE_TIER_TABLES = mod.SURFACE_TIER_TABLES ?? null;
  allDeclaredAxes = mod.allDeclaredAxes ?? null;
  controlGroupsOn = mod.controlGroupsOn ?? null;
  publicRoadmap = mod.publicRoadmap ?? null;
}

/** Reflect a Zod object's top-level keys. Handles superRefine wrappers and unions. */
function zodKeys(schema) {
  if (!schema) return null;
  if (schema.shape) return Object.keys(schema.shape);
  const variants = schema.options ?? schema._zod?.def?.options;
  if (Array.isArray(variants)) {
    const keys = new Set();
    for (const v of variants) {
      for (const k of Object.keys(v?.shape ?? {})) keys.add(k);
    }
    return Array.from(keys);
  }
  const inner = schema._zod?.def?.innerType ?? schema._def?.innerType;
  if (inner) return zodKeys(inner);
  return null;
}

/** Unwrap optional/nullable/array wrappers to reach an object schema. */
function unwrapToObject(schema, depth = 0) {
  if (!schema || depth > 8) return null;
  if (schema.shape) return schema;
  const def = schema._zod?.def ?? schema._def ?? {};
  const next = def.innerType ?? def.element ?? def.type;
  if (next && typeof next === "object") return unwrapToObject(next, depth + 1);
  return null;
}

// --- Static extraction for schemas that live in apps/api ------------------
//
// packages/shared must not import from apps/api (the dependency runs the other
// way), so those schemas cannot be reflected at runtime without booting the
// app. They are read from source with the TypeScript AST instead. Not a regex:
// several schemas in this repo contain regex literals with brace quantifiers
// (/^[a-z0-9_-]{1,64}$/), which defeats naive brace counting.

let ts = null;
try {
  ts = (await import("typescript")).default ?? (await import("typescript"));
} catch (err) {
  importFailures.push({ label: "typescript (for route-schema extraction)", err: String(err) });
}

function extractRouteSchemaKeys(absPath, constName) {
  if (!ts) return null;
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const src = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);
  let result = null;

  function objectLiteralKeysUnder(node) {
    let found = null;
    (function walk(n) {
      if (found) return;
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "object" &&
        n.arguments.length > 0 &&
        ts.isObjectLiteralExpression(n.arguments[0])
      ) {
        found = n.arguments[0].properties
          .map((p) => {
            if (!p.name) return null;
            if (ts.isIdentifier(p.name)) return p.name.text;
            if (ts.isStringLiteral(p.name)) return p.name.text;
            return null;
          })
          .filter(Boolean);
        return;
      }
      ts.forEachChild(n, walk);
    })(node);
    return found;
  }

  (function visit(node) {
    if (result) return;
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === constName &&
      node.initializer
    ) {
      result = objectLiteralKeysUnder(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  })(src);

  return result;
}

const TOKENS_ROUTE = join(REPO_ROOT, "apps", "api", "src", "routes", "reviews", "tokens.ts");
const RECIPIENT_ROUTE = join(
  REPO_ROOT, "apps", "api", "src", "routes", "token-reviews-recipient-actions.ts",
);

// --- The declared sources -------------------------------------------------
//
// The SOURCES are hardcoded; the AXES never are. That is the line this script's
// header draws and it still holds: adding a schema file is a deliberate act
// recorded here, while adding a KEY to any listed schema is caught automatically.

const AXIS_SOURCES = [
  { subsystem: "template", reflect: [
    { schema: templatesMod.TemplateCreateBodySchema, prefix: "" },
    { schema: templatesMod.TemplateUpdateBodySchema, prefix: "" },
  // Reachable without appearing on either body schema: `status` moves through
  // POST /:id/pause and /:id/resume, `draft_config` IS the draft body rather
  // than a key inside one. Both are operator-reachable, so both are axes.
  ], extraAxes: ["status", "draft_config"] },
  { subsystem: "action", reflect: [
    { schema: templatesMod.TemplateActionConfigSchema, prefix: "" },
  ] },
  { subsystem: "field", reflect: [
    { schema: templatesMod.TemplateFieldSchema, prefix: "" },
  ] },
  { subsystem: "review", reflect: [
    { schema: reviewsMod.ReviewCreateBodySchema, prefix: "" },
    { schema: unwrapToObject(reviewsMod.ReviewCreateBodySchema?.shape?.timeout), prefix: "timeout." },
    { schema: reviewsMod.AssignmentLadderStepSchema, prefix: "assignment_ladder." },
    { schema: reviewsMod.ReviewDecideBodySchema, prefix: "decide." },
    { schema: reviewsMod.ReviewVetoBodySchema, prefix: "veto." },
    { schema: reviewsMod.ReviewRetryBodySchema, prefix: "retry." },
    { schema: reviewsMod.ReviewActionBodySchema, prefix: "action." },
    { schema: reviewsMod.ReviewUpdateVersionBodySchema, prefix: "update." },
    { schema: reviewsMod.ReviewDraftBodySchema, prefix: "draft." },
    { schema: reviewsMod.ReviewBulkIdsBodySchema, prefix: "bulk." },
    { schema: reviewsMod.ReviewNoteBodySchema, prefix: "note." },
    { schema: reviewsMod.ReviewAssignBodySchema, prefix: "assign." },
    { schema: reviewsMod.ReviewSnoozeBodySchema, prefix: "snooze." },
  ], extraAxes: ["claim.force"] },
  { subsystem: "chain", reflect: [
    { schema: chainsMod.ChainDefinitionSchema, prefix: "" },
    { schema: chainsMod.ChainDefinitionStepSchema, prefix: "step." },
    { schema: chainsMod.AssigneeSpecSchema, prefix: "step.assignee." },
  ] },
  { subsystem: "chain_run", reflect: [
    { schema: chainsMod.ChainRunCreateBodySchema, prefix: "" },
  ] },
  { subsystem: "note", reflect: [
    { schema: notesMod.CreateNoteBodySchema, prefix: "create." },
    { schema: notesMod.PatchNoteBodySchema, prefix: "patch." },
    { schema: notesMod.CreateNoteAttachmentInput, prefix: "attachment." },
  ] },
  { subsystem: "team", reflect: [
    { schema: teamMod.TeamInviteBodySchema, prefix: "invite." },
    { schema: teamMod.TeamUpdateBodySchema, prefix: "member." },
  ] },
  { subsystem: "notifications", reflect: [
    { schema: notifPrefsMod.NotificationPrefsSchema, prefix: "" },
    { schema: unwrapToObject(notifPrefsMod.NotificationPrefsSchema?.shape?.quiet_hours), prefix: "quiet_hours." },
    { schema: unwrapToObject(notifPrefsMod.NotificationPrefsSchema?.shape?.digest), prefix: "digest." },
  ] },
  { subsystem: "webhook", reflect: [
    { schema: webhooksMod.WebhookCreateBodySchema, prefix: "" },
    { schema: webhooksMod.WebhookUpdateBodySchema, prefix: "" },
  ] },
  { subsystem: "api_key", reflect: [
    { schema: apiKeysMod.ApiKeyCreateBodySchema, prefix: "" },
    { schema: apiKeysMod.ApiKeyUpdateBodySchema, prefix: "" },
  ] },
  { subsystem: "project", reflect: [
    { schema: projectsMod.ProjectUpdateBodySchema, prefix: "" },
  ] },
  { subsystem: "token", static: [
    { file: TOKENS_ROUTE, constName: "ReviewTokenBodySchema", prefix: "" },
    { file: TOKENS_ROUTE, constName: "ExtendReviewTokenBodySchema", prefix: "extend." },
    { file: TOKENS_ROUTE, constName: "RevokeReviewTokenBodySchema", prefix: "revoke." },
  ] },
  { subsystem: "recipient", static: [
    { file: RECIPIENT_ROUTE, constName: "DeclineBodySchema", prefix: "decline." },
    { file: RECIPIENT_ROUTE, constName: "RaiseQuestionsBodySchema", prefix: "raise_questions." },
  ] },
  // `account` has no schema of any kind — login_notifications is hand-validated
  // with a typeof check. Declared in surface-tiers/ and deliberately given no
  // source here, because there is nothing to reflect. Named in tierNotes so the
  // hole stays visible instead of looking like coverage.
  { subsystem: "account", unverifiable: true },
];

if (!SURFACE_TIER_TABLES || !allDeclaredAxes) {
  tierFailures.push(
    "VACUOUS: packages/shared/src/surface-tiers/ did not load. The gate cannot run, so it fails rather than passing with zero coverage.",
  );
} else {
  const declared = new Map();
  for (const entry of allDeclaredAxes()) declared.set(entry.axisId, entry);

  const live = new Set();

  for (const source of AXIS_SOURCES) {
    if (source.unverifiable) {
      tierNotes.push(
        `${source.subsystem}: declared but not machine-verifiable (no schema exists to reflect).`,
      );
      for (const key of Object.keys(SURFACE_TIER_TABLES[source.subsystem] ?? {})) {
        live.add(`${source.subsystem}.${key}`);
      }
      continue;
    }

    if (!SURFACE_TIER_TABLES[source.subsystem]) {
      tierFailures.push(
        `VACUOUS: source "${source.subsystem}" is registered in audit-surface.mjs but has no table in surface-tiers.ts.`,
      );
      continue;
    }

    for (const spec of source.reflect ?? []) {
      const keys = zodKeys(spec.schema);
      if (!keys || keys.length === 0) {
        tierFailures.push(
          `VACUOUS: ${source.subsystem} source (prefix "${spec.prefix}") reflected no keys. ` +
            `A gate that sees nothing passes everything — fix the import before trusting this run.`,
        );
        continue;
      }
      for (const k of keys) live.add(`${source.subsystem}.${spec.prefix}${k}`);
    }

    for (const spec of source.static ?? []) {
      const keys = extractRouteSchemaKeys(spec.file, spec.constName);
      if (!keys || keys.length === 0) {
        tierFailures.push(
          `VACUOUS: could not extract ${spec.constName} from ${rel(spec.file)}. ` +
            `This schema is not type-enforced, so this script is its only check.`,
        );
        continue;
      }
      for (const k of keys) live.add(`${source.subsystem}.${spec.prefix}${k}`);
    }

    for (const extra of source.extraAxes ?? []) {
      live.add(`${source.subsystem}.${extra}`);
    }
  }

  for (const axisId of Array.from(live).sort()) {
    if (!declared.has(axisId)) {
      tierFailures.push(
        `UNDECLARED: ${axisId} exists in a live schema and has no tier. ` +
          `Assign one in packages/shared/src/surface-tiers.ts — core, advanced, roadmap, request or inert.`,
      );
    }
  }

  for (const axisId of Array.from(declared.keys()).sort()) {
    if (!live.has(axisId)) {
      tierFailures.push(
        `STALE: ${axisId} is tiered in surface-tiers.ts but no live schema carries it. ` +
          `Remove the declaration, or fix the source registration if the schema moved.`,
      );
    }
  }

  // --- committed generated artifact must not go stale --------------------
  //
  // site/ builds separately (Cloudflare Pages, from site/** only) and does not
  // depend on this workspace, so the public roadmap has to be a committed data
  // file rather than a live import. That makes staleness possible, so it is
  // checked here: the roadmap page's content is derived, and this is what keeps
  // "derived" true.
  try {
    const { buildRoadmapPayload } = await import(join(REPO_ROOT, "scripts", "generate-surface-docs.mjs"));
    const committedPath = join(REPO_ROOT, "site", "src", "lib", "roadmap-data.json");
    const expected = JSON.stringify(buildRoadmapPayload(), null, 2) + "\n";
    let actual = null;
    try {
      actual = readFileSync(committedPath, "utf8");
    } catch {
      actual = null;
    }
    if (actual === null) {
      tierFailures.push(
        `STALE ARTIFACT: site/src/lib/roadmap-data.json is missing. Run \`pnpm surface:docs\`.`,
      );
    } else if (actual !== expected) {
      tierFailures.push(
        `STALE ARTIFACT: site/src/lib/roadmap-data.json no longer matches the roadmap tier. ` +
          `The public roadmap page renders from it, so it would publish a stale promise. Run \`pnpm surface:docs\`.`,
      );
    }
  } catch (err) {
    tierFailures.push(`VACUOUS: could not verify the generated roadmap artifact — ${String(err)}`);
  }

  jsonOut.surface_tiers = {
    axes: allDeclaredAxes().map(({ axisId, declaration }) => ({
      axis: axisId,
      tier: declaration.tier,
      surface: declaration.surface ?? null,
      group: declaration.group ?? null,
      roadmap_feature: declaration.roadmap?.feature ?? null,
      built: declaration.roadmap?.built ?? null,
      note: declaration.note ?? null,
    })),
    control_groups: Object.fromEntries(
      ["template-editor", "chain-builder", "review-inbox", "share-link-dialog", "settings"].map(
        (s) => [s, controlGroupsOn ? controlGroupsOn(s) : []],
      ),
    ),
    public_roadmap: publicRoadmap ? publicRoadmap() : [],
  };
  writeFileSync(jsonPath, JSON.stringify(jsonOut, (_, v) => (v === Infinity ? "Infinity" : v), 2), "utf8");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`audit-surface: surface inventory generated`);
console.log(`  md  → ${rel(mdPath)}`);
console.log(`  json → ${rel(jsonPath)}`);
console.log(`  API: ${apiCounts.paths} paths / ${apiCounts.operations} operations / ${apiCounts.schemas} schemas`);
console.log(`  REVIEW_STATUSES: ${REVIEW_STATUSES.length} values`);
console.log(`  FIELD_TYPES: ${FIELD_TYPES.length} values`);
console.log(`  AUDIT_ACTIONS: ${AUDIT_ACTIONS.length} total`);
console.log(`  NOTIFICATION_EVENTS: ${NOTIFICATION_EVENTS.length} events`);
console.log(`  Error codes (scanned): ${errorCodes.length}`);
console.log(`  Template flags (Zod reflection): ${templateFlags.length} fields`);
if (importFailures.length > 0) {
  console.log(`  Import failures: ${importFailures.length}`);
  for (const f of importFailures) {
    console.log(`    FAILED: ${f.label} — ${f.err}`);
  }
}

// --- Surface-tier gate result ---------------------------------------------

const declaredCount = allDeclaredAxes ? allDeclaredAxes().length : 0;
console.log(`  Surface tiers: ${declaredCount} axes declared across ${AXIS_SOURCES.length} subsystems`);
for (const n of tierNotes) console.log(`    note: ${n}`);

if (tierFailures.length > 0) {
  console.error("");
  console.error(`audit-surface: SURFACE TIER GATE FAILED (${tierFailures.length} problem${tierFailures.length === 1 ? "" : "s"})`);
  console.error("");
  for (const f of tierFailures) console.error(`  ${f}`);
  console.error("");
  console.error("  Surface is declared, not emergent. A new configuration axis does not");
  console.error("  reach users until someone decides whether it belongs in the launch UI");
  console.error("  (core), behind a disclosure (advanced), on the public roadmap (roadmap),");
  console.error("  in the request contract (request), or nowhere (inert).");
  console.error("  Decide in packages/shared/src/surface-tiers.ts.");
  console.error("");
  process.exit(1);
}

console.log("  Surface tier gate: PASS");
process.exit(0);
