/** Verify that development accessibility checks run at the configured cadence and stop on teardown. */

import {
  shouldRunA11yRuntimeTick,
  startA11yRuntimeTick,
} from "../../apps/fieldops/src/mobile-a11y-runtime-tick";

type GlobalsLike = { __DEV__?: unknown };

describe("shouldRunA11yRuntimeTick (__DEV__ resolver)", () => {
  let originalDev: unknown;

  beforeEach(() => {
    originalDev = (globalThis as GlobalsLike).__DEV__;
  });

  afterEach(() => {
    (globalThis as GlobalsLike).__DEV__ = originalDev;
  });

  it("returns true when __DEV__ is truthy", () => {
    (globalThis as GlobalsLike).__DEV__ = true;
    expect(shouldRunA11yRuntimeTick()).toBe(true);
  });

  it("returns false when __DEV__ is false (production-bundle behavior)", () => {
    (globalThis as GlobalsLike).__DEV__ = false;
    expect(shouldRunA11yRuntimeTick()).toBe(false);
  });

  it("returns false when __DEV__ is undefined (test/shipped default)", () => {
    delete (globalThis as GlobalsLike).__DEV__;
    expect(shouldRunA11yRuntimeTick()).toBe(false);
  });

  it("returns false when __DEV__ is a non-truthy string (defensive coerce)", () => {
    (globalThis as GlobalsLike).__DEV__ = "";
    expect(shouldRunA11yRuntimeTick()).toBe(false);
  });
});

describe("startA11yRuntimeTick (scheduler)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("runs the audit synchronously on mount when runOnMount is true (default)", () => {
    const audit = jest.fn();
    const teardown = startA11yRuntimeTick(audit, { intervalMs: 1_000 });
    expect(audit).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("does not run on mount when runOnMount is false", () => {
    const audit = jest.fn();
    const teardown = startA11yRuntimeTick(audit, {
      intervalMs: 1_000,
      runOnMount: false,
    });
    expect(audit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(audit).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("schedules the audit at the requested cadence", () => {
    const audit = jest.fn();
    const teardown = startA11yRuntimeTick(audit, {
      intervalMs: 500,
      runOnMount: false,
    });
    jest.advanceTimersByTime(2_000);
    expect(audit).toHaveBeenCalledTimes(4);
    teardown();
  });

  it("uses the 30_000ms default when intervalMs is omitted", () => {
    const audit = jest.fn();
    const teardown = startA11yRuntimeTick(audit, { runOnMount: false });
    jest.advanceTimersByTime(29_999);
    expect(audit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(audit).toHaveBeenCalledTimes(1);
    teardown();
  });

  it("teardown stops the scheduler (no further audits fire)", () => {
    const audit = jest.fn();
    const teardown = startA11yRuntimeTick(audit, {
      intervalMs: 100,
      runOnMount: false,
    });
    jest.advanceTimersByTime(200);
    expect(audit).toHaveBeenCalledTimes(2);
    teardown();
    jest.advanceTimersByTime(1_000);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("teardown is idempotent (calling twice is safe)", () => {
    const audit = jest.fn();
    const teardown = startA11yRuntimeTick(audit, {
      intervalMs: 100,
      runOnMount: false,
    });
    expect(() => {
      teardown();
      teardown();
    }).not.toThrow();
  });

  it("returns a no-op teardown when audit is not a function", () => {
    const teardown = startA11yRuntimeTick(
      undefined as unknown as () => void,
      { intervalMs: 100 },
    );
    jest.advanceTimersByTime(1_000);
    expect(() => teardown()).not.toThrow();
  });

  it("swallows exceptions thrown by the audit (shell stays alive)", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {
      // suppress warn noise during the test
    });
    const audit = jest.fn(() => {
      throw new Error("intentional audit failure");
    });
    const teardown = startA11yRuntimeTick(audit, {
      intervalMs: 100,
      runOnMount: true,
    });
    // First synchronous call already threw — but no propagation.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    expect(audit).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    teardown();
  });
});
