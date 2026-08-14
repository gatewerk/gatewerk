/**
 * Fallback declaration for the Cloud tree, which lives in the private ./ee
 * submodule and is therefore absent from any public clone.
 *
 * Why this is needed at all: src/ reaches the Cloud tree only through
 * `isCloud() ? lazy(() => import("@ee/…")) : null`. Vite constant-folds
 * isCloud() and Rollup deletes the branch, so the OSS *bundle* never contains
 * a byte of it. TypeScript has no such elimination — it type-resolves every
 * `import()` expression it can see, so with the submodule absent all eleven
 * call sites fail with TS2307 and `pnpm typecheck` goes red on a clean public
 * clone. That would make the OSS repo un-buildable by anyone outside the org,
 * which is the one thing the split must not do.
 *
 * Why it is safe: this is an ambient wildcard, which TypeScript consults only
 * AFTER normal resolution fails. When the submodule IS checked out, the
 * "@ee/*" entry in tsconfig.json's `paths` resolves to the real files and
 * those types win — so cloud typechecking keeps its full strength and a
 * mismatch between src/ and the Cloud tree is still a compile error. That
 * precedence is not assumed; it is asserted by
 * src/__tests__/ee-shim-precedence.test.ts, which fails if the shim ever
 * starts masking the real modules.
 *
 * The modules are deliberately untyped (implicitly `any`). Hand-written
 * signatures here would be a second source of truth for the Cloud components
 * and would drift silently, which is worse than no types on a path that only
 * runs when the real modules are present anyway.
 *
 * One consequence: a lazy component from an untyped module types as
 * LazyExoticComponent<any>, which JSX treats as accepting NO props. A Cloud
 * component that takes props must therefore be cast to ComponentType<Props>
 * at its call site (see IconRail's ProductFeedbackModalCloud); the cast is
 * the consumer's contract, not a copy of the Cloud signature.
 */
declare module "@ee/*";
