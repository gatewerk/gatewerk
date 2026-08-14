# @gatewerk/web-core

Everything the two frontends share that is **not markup**: the API client, pure
libraries, framework-free page state, and React hooks that carry no JSX.

## Why this exists

`apps/web-next` used to reach into `apps/web` through a Vite alias (`@` →
`../web/src`). That made `apps/web` undeletable and turned the planned cutover
into a cliff: the two apps had already begun to diverge behaviourally while both
were live. The fix: extract the shared core first, so
deleting `apps/web` at cutover is a delete rather than a migration.

## The boundary

**In here:** anything that has no markup.

| Directory | What it holds |
|---|---|
| `src/api/` | the whole HTTP client, per-resource modules, optimistic-mutation wiring |
| `src/lib/` | pure utilities: errors, labels, dates, theme model, live events, clipboard |
| `src/hooks/` | React hooks with no JSX markup (`use-auth`, `use-theme`, shortcuts, …) |
| `src/state/` | framework-free screen state, formerly `apps/web/src/pages/**/*-state.ts` |

**Not in here:** anything that renders. Components, pages, shells and route
entries stay in the app that owns them.

The rule is *markup*, not file extension. `use-auth.tsx` and `use-theme.tsx` live
here despite being `.tsx`, because their only JSX is a context `Provider` and
they contain zero `className`. That distinction matters: **nothing in this
package carries a Tailwind class**, so neither app has to add an `@source`
directive for it. Move a styled component in here and that stops being true —
`apps/web-next/src/theme/tokens.css` has no `@source`, so its Tailwind build
would never scan this package and the component would render unstyled.

`src/api`, `src/lib` and `src/hooks` have no imports back into `components/`,
`pages/` or `shell/`. That downward-only boundary is what made the extraction a
pure move; keep it.

## Resolution

Both apps resolve this package by **alias**, not by package `exports`:

- `tsconfig.json` → `"@gatewerk/web-core/*": [".../packages/web-core/src/*"]`
- `vite.config.ts` and `vitest.config.ts` → `resolve.alias`

`exports` wildcards cannot express "try `.ts`, then `.tsx`" without fallback
arrays that Vite and `tsc` honour inconsistently, and this package is a mix of
both. Aliasing is the same mechanism that resolved `@` before the extraction, so
it carries no new risk.

## Tests

The state modules brought their tests with them, including
`src/state/templates/detail/draft-config-preservation.test.ts` — the 13-case gate
that stops the template editor silently deleting roadmap-tier values an operator
set over the API. Living here, it now guards **both** frontends instead of only
`apps/web`.

Run them with `pnpm --filter @gatewerk/web-core test`.
