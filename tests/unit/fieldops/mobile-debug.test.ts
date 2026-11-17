import {
  buildDebugFailurePayload,
  installUnhandledRejectionHandler,
  installGlobalCrashHandler,
  normalizeDebugMessage,
} from "../../../apps/fieldops/src/mobile-debug";

function isConsoleWarnMocked(): jest.SpiedFunction<typeof console.warn> {
  return jest.spyOn(console, "warn").mockImplementation(() => undefined) as jest.SpiedFunction<
    typeof console.warn
  >;
}

describe("mobile debug helpers", () => {
  test("normalizes Error objects with stack when available", () => {
    const normalized = normalizeDebugMessage(new Error("auth timeout"));
    expect(normalized).toContain("auth timeout");
  });

  test("normalizes plain object payloads with safe fallback", () => {
    const normalized = normalizeDebugMessage({ reason: "network", status: 503 });
    expect(normalized).toEqual('{"reason":"network","status":503}');
  });

  test("builds structured payload without leaking raw object identity", () => {
    const payload = buildDebugFailurePayload("failed sync", { reason: "disk full" }, "fieldops:background-location");

    expect(payload).toMatchObject({
      event: "mobile.debug_failure",
      namespace: "fieldops:background-location",
      context: "failed sync",
      message: '{"reason":"disk full"}',
    });
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("logDebugFailure logs in dev and skips in production", () => {
    const warnSpy = isConsoleWarnMocked();
    const globalEnv = globalThis as {
      __DEV__?: boolean;
    };
    const originalDev = globalEnv.__DEV__;

    globalEnv.__DEV__ = true;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { logDebugFailure } = require("../../../apps/fieldops/src/mobile-debug");

    logDebugFailure("failed to initialize", new Error("dev"), "fieldops");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    globalEnv.__DEV__ = false;
    warnSpy.mockClear();
    logDebugFailure("failed to initialize", new Error("prod"), "fieldops");
    expect(warnSpy).not.toHaveBeenCalled();

    globalEnv.__DEV__ = originalDev;
    warnSpy.mockRestore();
  });

  test("installGlobalCrashHandler installs and restores ErrorUtils handler", () => {
    const originalHandler = jest.fn();
    const errorUtils = {
      getGlobalHandler: jest.fn(() => originalHandler),
      setGlobalHandler: jest.fn(),
    };

    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ErrorUtils");
    Object.defineProperty(globalThis, "ErrorUtils", {
      configurable: true,
      value: errorUtils,
      writable: true,
    });

    const crashSpy = jest.fn();
    const dispose = installGlobalCrashHandler(crashSpy);

    expect(errorUtils.setGlobalHandler).toHaveBeenCalledTimes(1);
    expect(errorUtils.getGlobalHandler).toHaveBeenCalledTimes(1);
    expect(dispose).toBeInstanceOf(Function);

    const handler = errorUtils.setGlobalHandler.mock.calls[0]?.[0] as
      | ((error: unknown, isFatal?: boolean) => void)
      | undefined;
    const thrown = new Error("crash");
    handler?.(thrown, true);

    expect(crashSpy).toHaveBeenCalledTimes(1);
    expect(crashSpy).toHaveBeenCalledWith(
      thrown,
      expect.objectContaining({
        isFatal: true,
      })
    );

    dispose?.();
    expect(errorUtils.setGlobalHandler).toHaveBeenCalledTimes(2);
    expect(errorUtils.setGlobalHandler.mock.calls[1]?.[0]).toBe(originalHandler);

    if (originalDescriptor) {
      Object.defineProperty(globalThis, "ErrorUtils", originalDescriptor);
    } else {
      delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
    }
  });

  test("installUnhandledRejectionHandler installs and restores listener", () => {
    const globalErrorTarget = globalThis as {
      addEventListener?: jest.Mock;
      removeEventListener?: jest.Mock;
    };
    const originalAddEventListener = globalErrorTarget.addEventListener;
    const originalRemoveEventListener = globalErrorTarget.removeEventListener;

    const listenerMock = jest.fn();
    const removerMock = jest.fn();
    globalErrorTarget.addEventListener = listenerMock;
    globalErrorTarget.removeEventListener = removerMock;

    const rejectionSpy = jest.fn();
    const disposer = installUnhandledRejectionHandler(rejectionSpy);

    try {
      expect(listenerMock).toHaveBeenCalledTimes(1);
      const handler = listenerMock.mock.calls[0]?.[1] as
        | ((event: { reason?: unknown; promise?: unknown }) => void)
        | undefined;
      const reason = new Error("unhandled");
      const promise = { kind: "mock-promise" };

      handler?.({ reason, promise });
      expect(rejectionSpy).toHaveBeenCalledTimes(1);
      expect(rejectionSpy).toHaveBeenCalledWith(reason, promise);

      disposer?.();
      expect(removerMock).toHaveBeenCalledTimes(1);
      expect(removerMock).toHaveBeenCalledWith(
        "unhandledrejection",
        expect.any(Function)
      );
    } finally {
      if (typeof disposer === "function") {
        disposer();
      }
      globalErrorTarget.addEventListener = originalAddEventListener;
      globalErrorTarget.removeEventListener = originalRemoveEventListener;
    }
  });

  test("installUnhandledRejectionHandler returns null without event API", () => {
    const globalErrorTarget = globalThis as {
      addEventListener?: jest.Mock;
      removeEventListener?: jest.Mock;
      onunhandledrejection?: jest.Mock;
    };
    const originalAddEventListener = globalErrorTarget.addEventListener;
    const originalRemoveEventListener = globalErrorTarget.removeEventListener;
    const originalOnUnhandledRejection = globalErrorTarget.onunhandledrejection;

    delete (globalErrorTarget as { addEventListener?: unknown }).addEventListener;
    delete (globalErrorTarget as { removeEventListener?: unknown }).removeEventListener;
    delete (globalErrorTarget as { onunhandledrejection?: unknown }).onunhandledrejection;

    expect(installUnhandledRejectionHandler(jest.fn())).toBeNull();

    globalErrorTarget.addEventListener = originalAddEventListener;
    globalErrorTarget.removeEventListener = originalRemoveEventListener;
    globalErrorTarget.onunhandledrejection = originalOnUnhandledRejection;
  });

  test("installUnhandledRejectionHandler falls back to onunhandledrejection", () => {
    const globalErrorTarget = globalThis as {
      addEventListener?: jest.Mock;
      removeEventListener?: jest.Mock;
      onunhandledrejection?: jest.Mock;
    };
    const originalAddEventListener = globalErrorTarget.addEventListener;
    const originalRemoveEventListener = globalErrorTarget.removeEventListener;
    const originalOnUnhandledRejection = globalErrorTarget.onunhandledrejection;

    const previousHandler = jest.fn();
    globalErrorTarget.onunhandledrejection = previousHandler;
    delete (globalErrorTarget as { addEventListener?: unknown }).addEventListener;
    delete (globalErrorTarget as { removeEventListener?: unknown }).removeEventListener;

    const rejectionSpy = jest.fn();
    const disposer = installUnhandledRejectionHandler(rejectionSpy);

    try {
      const handler = globalErrorTarget.onunhandledrejection;
      const reason = new Error("unhandled");
      const promise = { kind: "mock-promise" };
      const event = { reason, promise, preventDefault: jest.fn() };

      handler?.(event);

      expect(rejectionSpy).toHaveBeenCalledTimes(1);
      expect(rejectionSpy).toHaveBeenCalledWith(reason, promise);
      expect(previousHandler).toHaveBeenCalledTimes(1);
      expect(previousHandler).toHaveBeenCalledWith(event);
    } finally {
      disposer?.();
      expect(globalErrorTarget.onunhandledrejection).toBe(previousHandler);
      globalErrorTarget.addEventListener = originalAddEventListener;
      globalErrorTarget.removeEventListener = originalRemoveEventListener;
      globalErrorTarget.onunhandledrejection = originalOnUnhandledRejection;
    }
  });
});
