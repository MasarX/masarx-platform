/** The prayer window banner renders an advisory status before a window and an alert during active dispatch suppression. Copy follows the locale supplied by the caller. */

/**
 * Three-state presentation contract for the ambient prayer-window banner.
 *
 *  - `idle`    → renders nothing (component returns null). Use when both
 *                `resolveActivePrayerWindow` and `pendingPrayerWarning` return
 *                null, or when policy.enabled === false.
 *  - `warning` → renders the pre-window advisory ("Salat in N min — wrapping
 *                up dispatch"). Caller MUST supply `minutesUntil`.
 *  - `active`  → renders the in-window banner ("Salat window — dispatch paused
 *                (N min remaining)"). Caller MUST supply `minutesRemaining`.
 */
export type PrayerWindowBannerState = "idle" | "warning" | "active";

/**
 * Locale selector for the banner copy. Intentionally narrow to the two
 * locales the FieldOps mobile shell ships today (en/ar). When additional
 * locales are added, the i18n migration must extend BOTH the shell-wide
 * locale union AND this type — the unit suite uses an exhaustive switch
 * to guard against silent locale drift.
 */
export type PrayerWindowBannerLocale = "en" | "ar";

/**
 * Public prop surface for the PrayerWindowBanner primitive.
 *
 * Notes for callers:
 *  - `state="idle"` causes the component to return null; the other props are
 *    not required to be valid in that case (the component does not read them).
 *  - `windowLabel` is the resolved human-readable name for the prayer window.
 *    Caller is expected to pass `window.label_en` (en) or `window.label_ar`
 *    (ar) from the active/pending PrayerWindow returned by the resolver.
 *  - `minutesUntil` is required when `state="warning"`. The primitive does
 *    not coerce or default this value — caller must round/floor/ceil per
 *    the resolver helper output (which already ceil-rounds to 1 minimum).
 *  - `minutesRemaining` is required when `state="active"`. Same contract.
 *  - `accessibilityRole` is set internally based on `state`:
 *      - warning → "status" (advisory, polite announcement)
 *      - active  → "alert"  (immediate, screen-reader interrupts current focus)
 *  - `testID` defaults to `prayer-window-banner`. Nested nodes derive testIDs
 *    by suffixing (`-title`, `-meta`).
 */
export type PrayerWindowBannerProps = {
  /** Three-state contract. `idle` causes the component to render nothing. */
  state: PrayerWindowBannerState;
  /** Human-readable prayer window name (e.g. "Dhuhr" or "الظهر"). */
  windowLabel: string;
  /**
   * Minutes until the warning window's prayer time begins. Required when
   * `state="warning"`. Caller passes the resolver's pre-rounded value.
   */
  minutesUntil?: number;
  /**
   * Minutes remaining in the currently-active prayer window. Required when
   * `state="active"`. Caller computes this from the resolver's window
   * descriptor (suppression_minutes minus elapsed).
   */
  minutesRemaining?: number;
  /**
   * Active app locale. Drives copy ("Salat in N min" vs "صلاة بعد N دقيقة")
   * and is also intended to be used by the consumer to pick the appropriate
   * label_en / label_ar before passing into `windowLabel`.
   */
  locale: PrayerWindowBannerLocale;
  /** Override the default `prayer-window-banner` testID. Suffixed for nested nodes. */
  testID?: string;
};
