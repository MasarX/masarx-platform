import { defineConsolePageLoadPerformanceTests } from "./utils/page-load-performance";

/**
 * Performance page-load tests for Console.
 *
 * Measures key page load and web-vitals budgets for critical Console routes.
 * Portal owns the same contract in `portal.performance-page-load.spec.ts` so
 * each Playwright project starts only the surface it actually tests.
 * Strict/CI keeps the production page-load budget; non-strict local dev can use
 * `PERF_LOCAL_PAGE_LOAD_MAX_MS` to avoid counting Next dev-server overhead.
 */
defineConsolePageLoadPerformanceTests();
