/**
 * payload-fields.ts — pure: resolve payload → ordered FieldDescriptor[].
 *
 * PAYLOAD-FIRST (matches old app ReviewPane.tsx lines 160-249):
 *   1. Build a fieldMeta Map from template.fields (preferred) or template_fields
 *      (snapshot fallback). Editable only when editable===true AND NOT readonly.
 *   2. Iterate Object.entries(payload) IN PAYLOAD ORDER.
 *      For each key: look up meta, derive type/label/editable/options; value = payload[key].
 *
 * Pure — no React, no fetch, no side effects. TDD-covered in payload-fields.test.ts.
 */
import type { FieldType } from "@gatewerk/shared";
import { FIELD_TYPES } from "@gatewerk/shared";

export interface FieldDescriptor {
  name: string;
  label: string;
  type: FieldType;
  editable: boolean;
  options?: string[];
  value: unknown;
}

// ── type guard ──
const FIELD_TYPE_SET = new Set<string>(FIELD_TYPES);
function isFieldType(s: string): s is FieldType {
  return FIELD_TYPE_SET.has(s);
}

// ── URL heuristic ──
const URL_PATTERN = /^https?:\/\//i;

/**
 * Infer a FieldType from a runtime value (fallback when no meta).
 */
export function inferType(value: unknown): FieldType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    if (URL_PATTERN.test(value)) return "url";
    return "text";
  }
  if (Array.isArray(value)) return "json";
  if (value !== null && typeof value === "object") return "json";
  return "text";
}

/**
 * Title-case a snake_case / camelCase key for display labels.
 */
export function toTitleCase(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface FieldMetaSource {
  name: string;
  label?: string;
  type: string;
  editable?: boolean;
  readonly?: boolean;
  options?: string[];
}

interface FieldMeta {
  /** undefined when the meta type is unknown → caller falls back to inferType */
  type: FieldType | undefined;
  label: string;
  editable: boolean;
  options?: string[];
}

function buildMetaMap(sources: FieldMetaSource[]): Map<string, FieldMeta> {
  const map = new Map<string, FieldMeta>();
  for (const f of sources) {
    const rawType = f.type ?? "";
    map.set(f.name, {
      // Only store if it's a known FieldType; undefined triggers inferType at resolution
      type: isFieldType(rawType) ? rawType : undefined,
      label: f.label || toTitleCase(f.name),
      // editable only when explicitly true AND not marked readonly
      editable: f.editable === true && f.readonly !== true,
      options: f.options,
    });
  }
  return map;
}

/**
 * Resolve a Review-shaped object into an ordered array of FieldDescriptors.
 * Input typed loosely to stay pure and testable without the full Review type.
 */
export function resolveFields(review: {
  payload: Record<string, unknown> | null | undefined;
  template?: {
    fields?: Array<FieldMetaSource> | null;
  } | null;
  template_fields?: Array<FieldMetaSource> | null;
}): FieldDescriptor[] {
  const payload = review.payload ?? {};

  // Build meta map: prefer live template.fields; fall back to snapshot
  const metaSources =
    review.template?.fields ??
    review.template_fields ??
    [];
  const fieldMeta = buildMetaMap(metaSources);

  // Iterate payload IN PAYLOAD ORDER (payload-first)
  return Object.entries(payload).map(([key, value]) => {
    const meta = fieldMeta.get(key);
    return {
      name: key,
      label: meta?.label ?? toTitleCase(key),
      type: meta?.type != null ? meta.type : inferType(value),
      editable: meta?.editable ?? false,
      options: meta?.options,
      value,
    };
  });
}
