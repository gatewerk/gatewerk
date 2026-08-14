# Email i18n (reserved)

Emails are **English only** at launch. This directory reserves the structure
for adding locales later without breaking the template public interface.

## Current state

`index.ts` declares the `Locale` union and `DEFAULT_LOCALE`. No translation
tables and no locale lookup exist yet — every template hardcodes English copy.

## Adding a locale later (non-breaking plan)

When translations are introduced:

1. Extend the `Locale` union (e.g. `"en" | "de" | "es"`).
2. Add a per-locale string table and a lookup helper here.
3. Give templates an optional `locale?: Locale` prop defaulting to
   `DEFAULT_LOCALE`. Because it defaults, existing call sites that pass no
   `locale` keep rendering English unchanged — the template props stay
   backward compatible and `renderEmail` needs no signature change.

A `LocaleProvider` (or equivalent context) is intentionally **not** shipped
yet: with no translation tables to feed it, it would be dead code. It arrives
in the same change that adds the first non-English string table.
