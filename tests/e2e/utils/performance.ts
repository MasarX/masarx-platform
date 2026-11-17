import { expect, type Page } from "@playwright/test";

type NavigationMetrics = {
  duration: number | null;
  ttfb: number | null;
  domContentLoaded: number | null;
};

type WebVitals = {
  lcp: number | null;
  cls: number;
  fcp: number | null;
  inp: number | null;
};

type InteractionTimingSample = {
  duration?: number | null;
  interactionId?: number | null;
};

export function parseThreshold(value: string | undefined) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseFloatThreshold(value: string | undefined) {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function computeMaxInteractionLatency(
  entries: InteractionTimingSample[]
) {
  let max: number | null = null;
  for (const entry of entries) {
    const duration = Number(entry?.duration);
    const interactionId = Number(entry?.interactionId ?? 0);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    if (!Number.isFinite(interactionId) || interactionId <= 0) continue;
    max = max === null ? duration : Math.max(max, duration);
  }
  return max;
}

export async function installWebVitalsObserver(page: Page) {
  await page.addInitScript(() => {
    const win = window as typeof window & {
      __e2eVitals?: { lcp: number | null; cls: number; inp: number | null };
    };
    win.__e2eVitals = { lcp: null, cls: 0, inp: null };

    if ("PerformanceObserver" in window) {
      try {
        const lcpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          if (last) {
            win.__e2eVitals!.lcp = last.startTime;
          }
        });
        lcpObserver.observe({
          type: "largest-contentful-paint",
          buffered: true,
        });
      } catch {
        // Ignore unsupported entry types.
      }

      try {
        const eventObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<{
            duration: number;
            interactionId?: number;
          }>) {
            if (!entry || (entry.interactionId ?? 0) <= 0) continue;
            const duration = Number(entry.duration);
            if (!Number.isFinite(duration) || duration <= 0) continue;
            const previous = win.__e2eVitals!.inp;
            win.__e2eVitals!.inp =
              previous === null ? duration : Math.max(previous, duration);
          }
        });
        eventObserver.observe({
          type: "event",
          buffered: true,
          durationThreshold: 16,
        });
      } catch {
        // Ignore unsupported entry types.
      }

      try {
        const clsObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<{
            value: number;
            hadRecentInput?: boolean;
          }>) {
            if (!entry.hadRecentInput) {
              win.__e2eVitals!.cls += entry.value;
            }
          }
        });
        clsObserver.observe({ type: "layout-shift", buffered: true });
      } catch {
        // Ignore unsupported entry types.
      }
    }
  });
}

export async function assertNavigationPerformance(page: Page) {
  const maxTotalMs = parseThreshold(process.env.E2E_NAV_MAX_TOTAL_MS);
  const maxTtfbMs = parseThreshold(process.env.E2E_NAV_MAX_TTFB_MS);
  const maxDclMs = parseThreshold(process.env.E2E_NAV_MAX_DCL_MS);

  const metrics = await page.evaluate(() => {
    const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (!entries || entries.length === 0) {
      return { duration: null, ttfb: null, domContentLoaded: null };
    }
    const entry = entries[0];
    return {
      duration: entry.duration || null,
      ttfb: entry.responseStart || null,
      domContentLoaded: entry.domContentLoadedEventEnd || null,
    };
  });

  if (maxTotalMs && metrics.duration !== null) {
    expect(metrics.duration).toBeLessThanOrEqual(maxTotalMs);
  }
  if (maxTtfbMs && metrics.ttfb !== null) {
    expect(metrics.ttfb).toBeLessThanOrEqual(maxTtfbMs);
  }
  if (maxDclMs && metrics.domContentLoaded !== null) {
    expect(metrics.domContentLoaded).toBeLessThanOrEqual(maxDclMs);
  }

  return metrics as NavigationMetrics;
}

export async function assertWebVitals(page: Page) {
  const maxLcpMs = parseThreshold(process.env.E2E_LCP_MAX_MS);
  const maxFcpMs = parseThreshold(process.env.E2E_FCP_MAX_MS);
  const maxInpMs = parseThreshold(process.env.E2E_INP_MAX_MS);
  const maxCls = parseFloatThreshold(process.env.E2E_CLS_MAX);
  const metrics = await page.evaluate(() => {
    const win = window as typeof window & {
      __e2eVitals?: { lcp: number | null; cls: number; inp: number | null };
    };
    const paintEntries = performance.getEntriesByType("paint") as PerformanceEntry[];
    const fcpEntry = paintEntries.find((entry) => entry.name === "first-contentful-paint");
    const eventSamples: Array<{ duration?: number; interactionId?: number }> = [];
    try {
      const eventEntries = performance.getEntriesByType("event");
      for (const entry of eventEntries as Array<{
        duration?: number;
        interactionId?: number;
      }>) {
        eventSamples.push({
          duration: entry.duration,
          interactionId: entry.interactionId,
        });
      }
    } catch {
      // Ignore unsupported entry types.
    }
    return {
      lcp: win.__e2eVitals?.lcp ?? null,
      cls: win.__e2eVitals?.cls ?? 0,
      fcp: fcpEntry?.startTime ?? null,
      inp: win.__e2eVitals?.inp ?? null,
      eventSamples,
    };
  });

  const inp =
    metrics.inp ?? computeMaxInteractionLatency(metrics.eventSamples ?? []);

  if (maxLcpMs && metrics.lcp !== null) {
    expect(metrics.lcp).toBeLessThanOrEqual(maxLcpMs);
  }
  if (maxFcpMs && metrics.fcp !== null) {
    expect(metrics.fcp).toBeLessThanOrEqual(maxFcpMs);
  }
  if (maxInpMs && inp !== null) {
    expect(inp).toBeLessThanOrEqual(maxInpMs);
  }
  if (maxCls !== null) {
    expect(metrics.cls).toBeLessThanOrEqual(maxCls);
  }

  return {
    lcp: metrics.lcp,
    cls: metrics.cls,
    fcp: metrics.fcp,
    inp,
  } as WebVitals;
}
