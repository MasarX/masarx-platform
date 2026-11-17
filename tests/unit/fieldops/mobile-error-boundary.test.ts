import { MobileErrorBoundary } from "../../../apps/fieldops/src/mobile-error-boundary";

describe("mobile error boundary", () => {
  test("renders children while not in error state", () => {
    const boundary = new MobileErrorBoundary({ children: "ok" });
    expect(boundary.render()).toBe("ok");
  });

  test("renders fallback UI when in error state", () => {
    const boundary = new MobileErrorBoundary({ children: "ok", fallback: "fallback" });
    boundary.state = { hasError: true };
    expect(boundary.render()).toBe("fallback");
  });

  test("logs render errors with component stack context", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const originalDev = globalThis.__DEV__;
    globalThis.__DEV__ = true;

    const boundary = new MobileErrorBoundary({ children: "ok" });
    const error = new Error("render-failed");
    boundary.componentDidCatch(error, { componentStack: "  in App", digest: null });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = warnSpy.mock.calls[0]?.[1] as
      | {
          event: string;
          context: string;
          namespace: string;
          message: string;
          timestamp: string;
        }
        | undefined;
    expect(payload?.context).toBe("react_render_error");
    expect(payload?.namespace).toBe("fieldops:crash");
    expect(payload?.message).toContain("in App");

    globalThis.__DEV__ = originalDev;
    warnSpy.mockRestore();
  });
});
