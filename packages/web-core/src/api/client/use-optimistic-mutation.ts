import { useMutation, useQueryClient, type QueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { MutationDef } from "./define";
import { mapError, showMappedError, type MappedError } from "../../lib/errors";

export type QueryKey = readonly unknown[];

export interface Snapshot {
  key: QueryKey;
  prev: unknown;
}

export interface OptimisticMutationOptions<I, O> {
  /**
   * Cache keys precisely affected by this mutation. Each returned key is:
   *   1. `cancelQueries`'d on mutate
   *   2. snapshotted via `getQueryData` for rollback
   *   3. patched via `onOptimistic` (if provided)
   *   4. updated from the server response via `onServerResponse` on success (if provided)
   *   5. restored to snapshot on error
   *
   * Keep minimal. Variants with unknown cache keys (e.g. every list-filter variation) belong in `invalidateOnSuccess`.
   */
  keys: (input: I) => ReadonlyArray<QueryKey>;

  /**
   * Apply the optimistic patch to the cached value for this key.
   * `prev` may be `undefined` if nothing is cached yet — return `undefined` to leave that key untouched.
   */
  onOptimistic?: (prev: unknown, input: I, key: QueryKey) => unknown;

  /**
   * Apply the server response to the cache for this key.
   * Defaults to no-op (optimistic state stays); provide when the optimistic patch may diverge from
   * server truth (server-computed fields like `decided_at`, `decided_by`, `version`).
   * Returning `undefined` leaves the key untouched.
   */
  onServerResponse?: (prev: unknown, response: O, input: I, key: QueryKey) => unknown;

  /**
   * Extra prefix keys to `invalidateQueries` on success — for caches that can't be precisely updated from
   * the response alone (e.g. every variant of `["reviews","list",filters]`). Not snapshotted, not rolled back.
   */
  invalidateOnSuccess?: (input: I) => ReadonlyArray<QueryKey>;

  /**
   * Runs after `mapError`, before the default toast.
   * Return `false` to suppress the default toast — useful for 409 flows that want their own `toast.info(...)`
   * and a targeted refetch (e.g. `version_mismatch`, `review_already_decided`).
   */
  onMappedError?: (mapped: MappedError, input: I, queryClient: QueryClient) => void | false;
}

export interface OptimisticLifecycle<I, O> {
  onMutate: (input: I) => Promise<Snapshot[]>;
  onError: (err: unknown, input: I, snapshots: Snapshot[] | undefined) => void;
  onSuccess: (data: O, input: I) => void;
}

/**
 * Pure builder that produces the React Query lifecycle callbacks. Exported for tests and
 * non-hook consumers (e.g. imperative mutations outside a component tree).
 *
 * Concurrent-mutation caveat: `cancelQueries` cancels in-flight refetches but NOT in-flight
 * mutations. If two mutations fire simultaneously against the same key, the second's snapshot
 * will include the first's optimistic update — rollback then restores to the first-optimistic
 * state, not the pre-both state. Mitigate by disabling mutation triggers while `isPending`.
 */
export function buildOptimisticLifecycle<I, O>(
  queryClient: QueryClient,
  options: OptimisticMutationOptions<I, O>,
): OptimisticLifecycle<I, O> {
  return {
    onMutate: async (input: I) => {
      const keys = options.keys(input);
      const snapshots: Snapshot[] = [];
      for (const key of keys) {
        await queryClient.cancelQueries({ queryKey: key });
        const prev = queryClient.getQueryData(key);
        snapshots.push({ key, prev });
        if (options.onOptimistic) {
          const next = options.onOptimistic(prev, input, key);
          if (next !== undefined) queryClient.setQueryData(key, next);
        }
      }
      return snapshots;
    },

    onError: (err, input, snapshots) => {
      if (snapshots) {
        for (const { key, prev } of snapshots) {
          queryClient.setQueryData(key, prev);
        }
      }
      const mapped = mapError(err);
      const suppress = options.onMappedError?.(mapped, input, queryClient) === false;
      if (!suppress) showMappedError(mapped);
    },

    onSuccess: (data, input) => {
      if (options.onServerResponse) {
        const keys = options.keys(input);
        for (const key of keys) {
          const prev = queryClient.getQueryData(key);
          const next = options.onServerResponse(prev, data, input, key);
          if (next !== undefined) queryClient.setQueryData(key, next);
        }
      }
      if (options.invalidateOnSuccess) {
        const keys = options.invalidateOnSuccess(input);
        for (const key of keys) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
    },
  };
}

/**
 * Wraps a typed `MutationDef` with the snapshot → optimistic → rollback pattern.
 *
 * Pattern: `cancelQueries(key)` → `getQueryData(key)` (snapshot) → `setQueryData(key, optimistic)` →
 *   on error: restore snapshot, surface mapped error;
 *   on success: apply server response via `setQueryData` (no automatic invalidate of affected keys —
 *   server response is the source of truth). `invalidateOnSuccess` handles secondary caches.
 */
export function useOptimisticMutation<I, O>(
  mutation: MutationDef<I, O>,
  options: OptimisticMutationOptions<I, O>,
): UseMutationResult<O, unknown, I, Snapshot[]> {
  const queryClient = useQueryClient();
  const lifecycle = buildOptimisticLifecycle(queryClient, options);
  return useMutation<O, unknown, I, Snapshot[]>({
    mutationFn: mutation.mutationFn,
    onMutate: lifecycle.onMutate,
    onError: lifecycle.onError,
    onSuccess: lifecycle.onSuccess,
  });
}
