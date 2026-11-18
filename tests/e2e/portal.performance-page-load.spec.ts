import { definePortalPageLoadPerformanceTests } from "./utils/page-load-performance";

/**
 * Performance page-load tests for Portal.
 *
 * Measures key page load and web-vitals budgets for critical Portal routes.
 * Strict/CI keeps the production page-load budget; non-strict local dev can use
 * `PERF_LOCAL_PAGE_LOAD_MAX_MS` to avoid counting Next dev-server overhead.
 */
definePortalPageLoadPerformanceTests();
