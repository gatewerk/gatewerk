// i18n scaffold for email templates. English only at launch; see README.md
// for the non-breaking plan to add locales. Kept to a type + default so the
// reserved structure is referenceable without shipping unused lookup code.

/** Supported email locales. Extended when translation tables are added. */
export type Locale = "en";

/** Locale used when a template is rendered without an explicit `locale`. */
export const DEFAULT_LOCALE: Locale = "en";
