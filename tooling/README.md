# tooling/

## `dist-verify.mjs`

Per-package CI gate that rebuilds the package and asserts `dist/` has not
drifted from source. Used by `gatewerk` (sdk-ts), `@gatewerk/mcp`, and
`n8n-nodes-gatewerk` to keep publishable artifacts honest.

### Modes

- Default: re-run `pnpm build`, then `git diff --quiet --exit-code -- dist/`.
  Exit 0 means dist/ is committed and matches the source.
- `--no-git-check`: re-run `pnpm build`, confirm `dist/` exists. Use this
  for packages that do not commit `dist/` to git (only build on publish).

### Drift causes

- Engineer edited `src/` without re-running `pnpm build` before commit.
- TypeScript compiler version bump emits subtly different `.js`/`.d.ts`.
- A consumer package's `tsconfig` changed in a way the build picks up but
  the committed dist/ does not reflect.

Fix: `pnpm --filter <package> build` locally, inspect the diff, commit.
