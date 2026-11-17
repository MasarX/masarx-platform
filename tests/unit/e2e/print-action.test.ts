import {
  clickPrintProgressControl,
  isRetriablePrintProgressControlError,
  waitForPrintProgressWidgetSurfaceState,
} from "../../e2e/utils/print-action";

function createLocator(options?: {
  isVisibleSequence?: boolean[];
  clickImpl?: jest.Mock<Promise<void>, [Record<string, unknown>?]>;
  roles?: Record<string, ReturnType<typeof createLocator>>;
}) {
  const isVisibleSequence = [...(options?.isVisibleSequence ?? [false])];
  return {
    isVisible: jest.fn(async () =>
      isVisibleSequence.length > 1
        ? Boolean(isVisibleSequence.shift())
        : Boolean(isVisibleSequence[0] ?? false)
    ),
    click:
      options?.clickImpl ??
      jest.fn(async () => {
        return;
      }),
    getByRole: jest.fn((_: string, config?: { name?: string }) => {
      const key = String(config?.name ?? "");
      const roleLocator = options?.roles?.[key];
      if (!roleLocator) {
        throw new Error(`Missing mocked role locator for ${key}`);
      }
      return roleLocator;
    }),
  };
}

describe("print action progress helpers", () => {
  test("classifies minimized state before expanded variants", async () => {
    const page = {
      waitForTimeout: jest.fn(async () => undefined),
    };
    const progressWidget = createLocator({
      isVisibleSequence: [true],
      roles: {
        Hide: createLocator({ isVisibleSequence: [true] }),
        Dismiss: createLocator({ isVisibleSequence: [false] }),
      },
    });
    const minimizedWidget = createLocator({ isVisibleSequence: [true] });

    await expect(
      waitForPrintProgressWidgetSurfaceState({
        page,
        progressWidget,
        minimizedWidget,
      })
    ).resolves.toBe("minimized");
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  test("classifies terminal expanded state when dismiss is visible", async () => {
    const page = {
      waitForTimeout: jest.fn(async () => undefined),
    };
    const progressWidget = createLocator({
      isVisibleSequence: [true],
      roles: {
        Hide: createLocator({ isVisibleSequence: [false] }),
        Dismiss: createLocator({ isVisibleSequence: [true] }),
      },
    });
    const minimizedWidget = createLocator({ isVisibleSequence: [false] });

    await expect(
      waitForPrintProgressWidgetSurfaceState({
        page,
        progressWidget,
        minimizedWidget,
      })
    ).resolves.toBe("expanded-terminal");
  });

  test("falls back to missing when both progress surfaces stay gone", async () => {
    const page = {
      waitForTimeout: jest.fn(async () => undefined),
    };
    const progressWidget = createLocator({ isVisibleSequence: [false, false, false] });
    const minimizedWidget = createLocator({ isVisibleSequence: [false, false, false] });

    await expect(
      waitForPrintProgressWidgetSurfaceState({
        page,
        progressWidget,
        minimizedWidget,
        timeoutMs: 5,
        pollIntervalMs: 1,
      })
    ).resolves.toBe("missing");
    expect(page.waitForTimeout).toHaveBeenCalled();
  });

  test("retries control clicks when the locator detaches during transition", async () => {
    const page = {
      waitForTimeout: jest.fn(async () => undefined),
    };
    const clickImpl = jest
      .fn<Promise<void>, [Record<string, unknown>?]>()
      .mockRejectedValueOnce(new Error("element was detached from the DOM"))
      .mockResolvedValueOnce(undefined);
    const control = createLocator({ clickImpl });

    await expect(
      clickPrintProgressControl({
        page,
        control,
        timeoutMs: 5_000,
      })
    ).resolves.toBeUndefined();
    expect(clickImpl).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalled();
  });

  test("treats a detachment as recovered when the success probe observes the new state", async () => {
    const page = {
      waitForTimeout: jest.fn(async () => undefined),
    };
    const clickImpl = jest
      .fn<Promise<void>, [Record<string, unknown>?]>()
      .mockRejectedValue(new Error("element was detached from the DOM"));
    const control = createLocator({ clickImpl });
    const successProbe = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(true);

    await expect(
      clickPrintProgressControl({
        page,
        control,
        timeoutMs: 5_000,
        successProbe,
      })
    ).resolves.toBeUndefined();
    expect(clickImpl).toHaveBeenCalledTimes(1);
    expect(successProbe).toHaveBeenCalledTimes(1);
  });

  test("only retries known transition errors", () => {
    expect(
      isRetriablePrintProgressControlError(new Error("element was detached from the DOM"))
    ).toBe(true);
    expect(
      isRetriablePrintProgressControlError(new Error("Target page, context or browser has been closed"))
    ).toBe(true);
    expect(isRetriablePrintProgressControlError(new Error("strict mode violation"))).toBe(
      false
    );
  });

  test("treats page-close errors as retriable when the success probe later confirms completion", async () => {
    const page = {
      waitForTimeout: jest.fn(async () => undefined),
    };
    const clickImpl = jest
      .fn<Promise<void>, [Record<string, unknown>?]>()
      .mockRejectedValue(new Error("Target page, context or browser has been closed"));
    const control = createLocator({ clickImpl });
    const successProbe = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      clickPrintProgressControl({
        page,
        control,
        timeoutMs: 5_000,
        pollIntervalMs: 1,
        successProbe,
      })
    ).resolves.toBeUndefined();
    expect(clickImpl).toHaveBeenCalledTimes(2);
    expect(successProbe).toHaveBeenCalledTimes(2);
  });
});
