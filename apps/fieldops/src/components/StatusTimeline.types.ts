/** Timeline props represent ordered lifecycle steps with shared status tones and optional notes. */

/**
 * Visual + lifecycle state for a single step in the timeline. Each value
 * resolves to a distinct background/foreground/opacity triple inside the
 * component (see `buildStatusTimelineStyles`). Adding a new state requires
 * extending the style factory so the exhaustive switch keeps holding.
 */
export type StatusTimelineStepState =
  | "complete"
  | "current"
  | "pending"
  | "skipped";

/**
 * Single step descriptor. Callers compose these into an ordered array and
 * hand them to the component; the component owns visual presentation only
 * (no business logic for "which step is current?" — that belongs to the
 * resolver that hydrates these props).
 *
 * Notes for callers:
 *  - `key` is required and must be unique within the timeline (used for
 *    React reconciliation AND testID suffix derivation).
 *  - `label` is the human-readable step name (e.g. "Created", "Assigned",
 *    "Picked up", "Delivered"). The component renders it verbatim; locale
 *    selection happens upstream.
 *  - `timestamp` is an optional ISO 8601 string. When supplied, the
 *    component renders it verbatim under the label as a small caption. The
 *    component does not perform relative-time formatting (e.g. "2 hours
 *    ago") because that belongs to the locale/format layer; callers should
 *    pre-format if they want a relative string.
 *  - `failureReason` is an extension hook for failed lifecycle states. When
 *    supplied, the component renders it verbatim under the label as a
 *    small danger-tinted caption. Use for "Pickup attempt failed: door
 *    locked" style narratives.
 */
export type StatusTimelineStep = {
  /** Unique identifier within the timeline. Used for React keys + testIDs. */
  key: string;
  /** Human-readable step name. Rendered verbatim. */
  label: string;
  /** Lifecycle state of this step. Drives tone + opacity. */
  state: StatusTimelineStepState;
  /** Optional ISO 8601 timestamp. Rendered verbatim under the label. */
  timestamp?: string;
  /** Optional failure narrative. Rendered as a small danger-tinted caption. */
  failureReason?: string;
};

/**
 * Public prop surface for the StatusTimeline primitive.
 *
 * Notes for callers:
 *  - `steps` is the ordered lifecycle. The component renders them in array
 *    order (top-to-bottom for vertical, left-to-right for horizontal).
 *    Empty arrays render an empty container (no error, no fallback copy)
 *    so callers can defer the "no data" copy to their own EmptyState.
 *  - `orientation` defaults to `"vertical"` because the typical detail
 *    view is a scrollable column and a vertical timeline composes more
 *    naturally with adjacent cards. Horizontal mode is provided for
 *    compact summary surfaces (e.g. dashboard tiles).
 *  - `testID` defaults to `status-timeline`. Per-step testIDs derive as
 *    `${testID}-step-${key}` so callers can target individual steps by
 *    their lifecycle key (e.g. `status-timeline-step-delivered`).
 *  - The component is informational only — it never accepts an onPress
 *    handler. Lifecycle interactions belong on the surrounding screen,
 *    not on the timeline glyph.
 */
export type StatusTimelineProps = {
  /** Ordered lifecycle steps. Empty array renders an empty container. */
  steps: StatusTimelineStep[];
  /** Layout direction. Defaults to `"vertical"`. */
  orientation?: "horizontal" | "vertical";
  /** Override the default `status-timeline` testID. Suffixed for nested nodes. */
  testID?: string;
};
