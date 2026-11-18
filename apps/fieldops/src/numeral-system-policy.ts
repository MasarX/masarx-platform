// Resolve localized digits from numeral_system_policy.
//
// Contract: the resolver `public.resolve_numeral_system_policy(p_context jsonb)`
// returns a row whose `value` column is a JSONB body:
//   {
//     version: 1,
//     default_numbering_system: "latn",
//     locale_overrides: {
//       ar:    { numbering_system: "latn",    allow_user_toggle: true },
//       ar_SA: { numbering_system: "arab",    allow_user_toggle: true },
//       ar_AE: { numbering_system: "latn",    allow_user_toggle: true },
//       ar_EG: { numbering_system: "arab",    allow_user_toggle: true },
//       fa:    { numbering_system: "arabext", allow_user_toggle: true }
//     }
//   }
//
// This module:
//  1. Defines the typed shape (NumeralSystemPolicyValue + NumberingSystem).
//  2. Normalizes the JSONB into a strict-typed object (defensive parse).
//  3. Exposes `resolveNumberingSystem(policy, locale)` — returns the right
//     numbering system token per locale, falling back to the policy default
//     (and then to "latn") when no override exists.
//  4. Exposes `formatNumber(policy, value, locale, options?)` — the
//     consumer-facing helper for rendering numbers via Intl.NumberFormat with
//     the resolved numberingSystem. Falls back to plain number.toString() if
//     the runtime Intl implementation does not support the requested system.
//  5. Ships a STATIC fallback that mirrors the global default seed exactly.
//
//
// behavior must read through resolver functions, not hardcoded code-side maps.
// MENA-region numeral conventions are non-uniform (KSA/EG → Arabic-Indic, UAE
// → Latin, Persian → Eastern Arabic-Indic) and shift over time, so hard-coding
// per-locale would force a release for every market preference change.
//
// Callers apply the resolved numbering system when formatting values.
// global default seed in
// supabase/migrations/202604241960_numeral_system_policy_v1.sql. The pgTAP
// test 0zd_numeral_system_policy.sql asserts the seed values. The Jest test
// tests/unit/numeral-system-policy.test.ts asserts that this static mirror
// matches the migration shape and exercises the resolver + formatter against
// multiple locales.

// Supported numbering systems. Maps directly to the Intl.NumberFormat
// `numberingSystem` option (BCP-47 numbering system identifiers).
//   latn    -> Latin / Western Arabic numerals (0-9)
//   arab    -> Arabic-Indic / Eastern Arabic numerals (٠-٩)
//   arabext -> Eastern Arabic-Indic / Persian numerals (۰-۹)
export type NumberingSystem = "latn" | "arab" | "arabext";

export type NumeralSystemLocaleOverride = {
  numbering_system: NumberingSystem;
  allow_user_toggle: boolean;
};

export type NumeralSystemPolicyValue = {
  version: number;
  default_numbering_system: NumberingSystem;
  locale_overrides: Record<string, NumeralSystemLocaleOverride>;
};

const VALID_NUMBERING_SYSTEMS: ReadonlySet<NumberingSystem> = new Set([
  "latn",
  "arab",
  "arabext",
]);

// Mirror of the migration seed (see supabase/migrations/202604241960_numeral_system_policy_v1.sql).
// Default `latn` for unknown locales (safest fallback — never crashes
// Intl.NumberFormat on any runtime). Per-locale overrides cover canonical
// MENA conventions. Each carries `allow_user_toggle: true` so per-user
// preference is permitted via the device layer.
//
// v9-residual-fix (D-09): bare `ar` (language-only Arabic) now maps to
// `arab` (Arabic-Indic / Eastern Arabic numerals) so that drivers whose
// device locale resolves to the bare `ar` code see Arabic-Indic digits
// across the FieldOps shell by default. Specific region overrides
// (`ar_SA` -> arab, `ar_AE` -> latn, `ar_EG` -> arab) keep MENA per-region
// conventions intact and continue to win over the bare-`ar` fallback.
// The bare-`ar` shift here is the device-layer default for any Arabic
// locale that does not carry a recognized region tag, and remains
// `allow_user_toggle: true` so the per-user preference path stays open.
export const STATIC_NUMERAL_SYSTEM: NumeralSystemPolicyValue = {
  version: 1,
  default_numbering_system: "latn",
  locale_overrides: {
    ar:    { numbering_system: "arab",    allow_user_toggle: true },
    ar_SA: { numbering_system: "arab",    allow_user_toggle: true },
    ar_AE: { numbering_system: "latn",    allow_user_toggle: true },
    ar_EG: { numbering_system: "arab",    allow_user_toggle: true },
    fa:    { numbering_system: "arabext", allow_user_toggle: true },
  },
};

// Coerce an arbitrary value into a valid NumberingSystem token, returning
// `fallback` when the input is not one of the supported tokens.
function coerceNumberingSystem(
  raw: unknown,
  fallback: NumberingSystem,
): NumberingSystem {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return VALID_NUMBERING_SYSTEMS.has(trimmed as NumberingSystem)
    ? (trimmed as NumberingSystem)
    : fallback;
}

// Deep clone the locale_overrides map to avoid sharing mutable references.
function cloneLocaleOverrides(
  src: Record<string, NumeralSystemLocaleOverride>,
): Record<string, NumeralSystemLocaleOverride> {
  const out: Record<string, NumeralSystemLocaleOverride> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = { ...v };
  }
  return out;
}

// Normalize an arbitrary JSONB-ish value (from the resolver) into a strict
// NumeralSystemPolicyValue. Defensive: invalid systems and malformed override
// entries fall back to the static seed values so a bad row in production
// cannot brick number rendering across the mobile shell.
export function normalizeNumeralSystemPolicy(
  raw: unknown,
): NumeralSystemPolicyValue {
  if (!raw || typeof raw !== "object") {
    return {
      version: STATIC_NUMERAL_SYSTEM.version,
      default_numbering_system: STATIC_NUMERAL_SYSTEM.default_numbering_system,
      locale_overrides: cloneLocaleOverrides(STATIC_NUMERAL_SYSTEM.locale_overrides),
    };
  }
  const obj = raw as Record<string, unknown>;

  const versionRaw = obj.version;
  const version =
    typeof versionRaw === "number" && Number.isFinite(versionRaw)
      ? Math.trunc(versionRaw)
      : STATIC_NUMERAL_SYSTEM.version;

  const default_numbering_system = coerceNumberingSystem(
    obj.default_numbering_system,
    STATIC_NUMERAL_SYSTEM.default_numbering_system,
  );

  const overridesRaw = obj.locale_overrides;
  const locale_overrides: Record<string, NumeralSystemLocaleOverride> = {};
  if (
    overridesRaw &&
    typeof overridesRaw === "object" &&
    !Array.isArray(overridesRaw)
  ) {
    for (const [locale, entry] of Object.entries(
      overridesRaw as Record<string, unknown>,
    )) {
      const trimmedLocale = locale.trim();
      if (!trimmedLocale) continue;
      // Reject non-objects, arrays, and nulls — only plain object entries
      // describe a valid override row. Critically, arrays satisfy
      // `typeof === "object"` and would otherwise leak through with
      // garbage-coerced numbering_system / allow_user_toggle defaults.
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry)
      ) {
        continue;
      }
      const entryObj = entry as Record<string, unknown>;
      // Require an explicit, in-enum numbering_system. Anything malformed
      // here means the row was never authored as a real override — drop it
      // rather than synthesize a default that masks bad config.
      const rawNumberingSystem = entryObj.numbering_system;
      if (
        typeof rawNumberingSystem !== "string" ||
        !VALID_NUMBERING_SYSTEMS.has(rawNumberingSystem.trim() as NumberingSystem)
      ) {
        // Special case: when the seed entry is structurally present but the
        // numbering_system is out-of-enum, fall back to the default rather
        // than dropping (preserves locale presence for downstream lookup).
        if ("numbering_system" in entryObj) {
          const fallbackNumberingSystem = default_numbering_system;
          const fallbackAllowToggle =
            typeof entryObj.allow_user_toggle === "boolean"
              ? entryObj.allow_user_toggle
              : true;
          locale_overrides[trimmedLocale] = {
            numbering_system: fallbackNumberingSystem,
            allow_user_toggle: fallbackAllowToggle,
          };
        }
        continue;
      }
      const numbering_system = coerceNumberingSystem(
        rawNumberingSystem,
        default_numbering_system,
      );
      const allow_user_toggle =
        typeof entryObj.allow_user_toggle === "boolean"
          ? entryObj.allow_user_toggle
          : true;
      locale_overrides[trimmedLocale] = { numbering_system, allow_user_toggle };
    }
  }

  return {
    version,
    default_numbering_system,
    locale_overrides,
  };
}

// Normalize a locale tag for lookup. We try the full tag first (e.g. "ar_SA"
// or "ar-SA"), then fall back to the language-only prefix (e.g. "ar"). Both
// underscore and hyphen separators are accepted (BCP-47 uses hyphens but the
// policy seed uses underscores for JSONB friendliness).
function normalizeLocaleTag(locale: string): string {
  return locale.trim();
}

function languagePrefix(locale: string): string {
  const trimmed = locale.trim();
  if (!trimmed) return "";
  // Split on either "_" or "-".
  const sepIdx = trimmed.search(/[_-]/);
  return sepIdx === -1 ? trimmed : trimmed.slice(0, sepIdx);
}

// Lookup the numbering system for a locale. Lookup order:
//   1. Exact match on the full locale tag (with underscore separator).
//   2. Exact match on the full locale tag with hyphen-to-underscore.
//   3. Exact match on the language-only prefix (e.g. "ar" for "ar_JO").
//   4. policy.default_numbering_system.
// Defensive: empty / non-string locale falls through to the default.
export function resolveNumberingSystem(
  policy: NumeralSystemPolicyValue,
  locale: string,
): NumberingSystem {
  if (typeof locale !== "string") return policy.default_numbering_system;
  const tag = normalizeLocaleTag(locale);
  if (!tag) return policy.default_numbering_system;

  // 1) Exact match (as-is).
  const direct = policy.locale_overrides[tag];
  if (direct) return direct.numbering_system;

  // 2) Hyphen-to-underscore swap (BCP-47 "ar-SA" → "ar_SA").
  if (tag.includes("-")) {
    const swapped = tag.replace(/-/g, "_");
    const swappedHit = policy.locale_overrides[swapped];
    if (swappedHit) return swappedHit.numbering_system;
  }

  // 3) Language-only prefix (e.g. "ar" for "ar_JO").
  const prefix = languagePrefix(tag);
  if (prefix && prefix !== tag) {
    const prefixHit = policy.locale_overrides[prefix];
    if (prefixHit) return prefixHit.numbering_system;
  }

  return policy.default_numbering_system;
}

// Convert an internal locale tag (which may use underscore separators like
// "ar_SA" for JSONB friendliness) into a BCP-47 / Intl-friendly form
// (hyphen separators like "ar-SA"). Empty / non-string inputs return "en"
// as a safe Intl-acceptable default.
function toIntlLocale(locale: string): string {
  if (typeof locale !== "string") return "en";
  const trimmed = locale.trim();
  if (!trimmed) return "en";
  return trimmed.replace(/_/g, "-");
}

// Format a number per the policy + locale, using Intl.NumberFormat with the
// resolved numberingSystem token.
//
// Examples (with the default seed):
//   formatNumber(policy, 1234.56, "ar_SA") → "١٬٢٣٤٫٥٦"
//   formatNumber(policy, 1234.56, "fa")    → "۱٬۲۳۴٫۵۶"
//   formatNumber(policy, 1234.56, "en")    → "1,234.56"
//   formatNumber(policy, 1234.56, "ar_AE") → "1,234.56"
//
// The locale tag is normalized from JSONB-friendly underscore form
// ("ar_SA") to BCP-47 hyphen form ("ar-SA") before being passed to
// Intl.NumberFormat (which rejects underscored tags as RangeError).
//
// Defensive: if Intl.NumberFormat throws (older runtime, unsupported locale,
// unsupported numbering system) OR the input value is non-finite, falls back
// to a plain `String(value)` rendering so the app never crashes on render.
export function formatNumber(
  policy: NumeralSystemPolicyValue,
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value);
  }
  const numberingSystem = resolveNumberingSystem(policy, locale);
  const intlLocale = toIntlLocale(locale);
  // Intl.NumberFormat accepts the numbering system either via `options` or
  // via locale extension (e.g. "ar-SA-u-nu-arab"). We pass it via options so
  // callers can override only the locale tag without losing the policy
  // selection.
  try {
    const fmt = new Intl.NumberFormat(intlLocale, {
      ...(options ?? {}),
      numberingSystem,
    } as Intl.NumberFormatOptions);
    return fmt.format(value);
  } catch {
    // Fall through to permissive fallback.
  }
  // Some older Intl runtimes do not honor `numberingSystem` in options; try
  // locale extension as a secondary attempt before giving up.
  try {
    const localeWithNu = intlLocale.includes("-u-")
      ? intlLocale
      : `${intlLocale}-u-nu-${numberingSystem}`;
    const fmt = new Intl.NumberFormat(localeWithNu, options);
    return fmt.format(value);
  } catch {
    // Final fallback: plain number.toString — guarantees the app never
    // crashes on a render path.
    return value.toString();
  }
}
