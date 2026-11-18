/**
 * Named pagination-limit constants.
 *
 * All page-size / fetch-limit values used across the UI should reference
 * these constants instead of inline magic numbers, making them auditable
 * and eventually resolvable from a `ui_pagination` settings category.
 *
 * TODO: resolve from ui_pagination settings via the override ladder.
 */

/** Default page size for list / table views. */
export const LIST_PAGE_SIZE = 50;

/** Default page size for detail / sub-resource views. */
export const DETAIL_PAGE_SIZE = 200;

/** Default fetch limit for geo / map pin queries. */
export const MAP_PIN_FETCH_LIMIT = 500;

/** Default page size for autocomplete / typeahead lookups. */
export const AUTOCOMPLETE_PAGE_SIZE = 25;
