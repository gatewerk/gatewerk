import type { z } from "zod";
import { request } from "./http";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface QueryDef<I, O> {
  (input: I): { queryKey: readonly unknown[]; queryFn: () => Promise<O> };
  /** Execute the query directly (bypasses React Query) — useful for one-shot fetches in event handlers. */
  run(input: I): Promise<O>;
}

export interface MutationDef<I, O> {
  (input: I): Promise<O>;
  /** React Query `mutationFn` surface (alias to the callable). */
  mutationFn: (input: I) => Promise<O>;
}

export interface DefineQueryConfig<I, O> {
  path: string | ((input: I) => string);
  queryKey: (input: I) => readonly unknown[];
  responseSchema?: z.ZodType<O>;
  search?: (input: I) => Record<string, string | number | undefined | null>;
}

export interface DefineMutationConfig<I, O> {
  path: string | ((input: I) => string);
  method: HttpMethod;
  bodySchema?: z.ZodType<I>;
  responseSchema?: z.ZodType<O>;
  /** Some mutations (e.g. delete-by-id) don't send a body even though input has an id. */
  bodyless?: boolean;
}

function resolvePath<I>(path: string | ((input: I) => string), input: I): string {
  return typeof path === "function" ? path(input) : path;
}

function appendSearch(path: string, search: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return path;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

async function parseResponse<O>(raw: unknown, schema?: z.ZodType<O>): Promise<O> {
  if (!schema) return raw as O;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    if (import.meta.env?.DEV) {
      console.warn("[api] response schema mismatch", parsed.error.issues);
    }
    return raw as O;
  }
  return parsed.data;
}

export function defineQuery<I, O>(config: DefineQueryConfig<I, O>): QueryDef<I, O> {
  const run = async (input: I): Promise<O> => {
    let path = resolvePath(config.path, input);
    if (config.search) {
      path = appendSearch(path, config.search(input));
    }
    const raw = await request<unknown>(path);
    return parseResponse(raw, config.responseSchema);
  };

  const fn = ((input: I) => ({
    queryKey: config.queryKey(input),
    queryFn: () => run(input),
  })) as QueryDef<I, O>;
  fn.run = run;
  return fn;
}

export function defineMutation<I, O>(config: DefineMutationConfig<I, O>): MutationDef<I, O> {
  const run = async (input: I): Promise<O> => {
    if (config.bodySchema) {
      const parsed = config.bodySchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `Invalid input to ${config.method} ${typeof config.path === "string" ? config.path : "<dynamic>"}: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
        );
      }
    }
    const path = resolvePath(config.path, input);
    const opts: RequestInit = { method: config.method };
    if (!config.bodyless && config.method !== "GET") {
      opts.body = JSON.stringify(input);
    }
    const raw = await request<unknown>(path, opts);
    return parseResponse(raw, config.responseSchema);
  };

  const fn = ((input: I) => run(input)) as MutationDef<I, O>;
  fn.mutationFn = run;
  return fn;
}
