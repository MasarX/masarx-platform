/** Verify that locale application updates React Native direction and that directional styles follow it. */

type FakeI18nManager = {
  isRTL: boolean;
  allowRTL: jest.Mock<void, [boolean]>;
  forceRTL: jest.Mock<void, [boolean]>;
};

// Mutable mock control. The `react-native` mock factory below returns a
// stable module object whose `I18nManager` property is a live getter into
// this slot, so mutations between tests are visible to the cached require()
// result inside the helper module.
const mockState: { manager: FakeI18nManager | null } = {
  manager: null,
};

jest.mock(
  "react-native",
  () => {
    const stableModule = {};
    Object.defineProperty(stableModule, "I18nManager", {
      configurable: true,
      enumerable: true,
      get(): FakeI18nManager | null {
        return mockState.manager;
      },
    });
    return stableModule;
  },
  { virtual: true }
);

import * as RTL from "../../apps/fieldops/src/mobile-shell-rtl";

function makeFakeManager(initialIsRTL: boolean): FakeI18nManager {
  return {
    isRTL: initialIsRTL,
    allowRTL: jest.fn<void, [boolean]>(),
    forceRTL: jest.fn<void, [boolean]>(),
  };
}

function setManager(manager: FakeI18nManager | null): void {
  mockState.manager = manager;
}

beforeEach(() => {
  setManager(null);
});

describe("mobile-shell-rtl helpers — applyRTLPolicy", () => {
  test("calls I18nManager.allowRTL(true) when react-native exposes a manager", () => {
    const manager = makeFakeManager(false);
    setManager(manager);
    RTL.applyRTLPolicy("en");
    expect(manager.allowRTL).toHaveBeenCalledWith(true);
  });

  test("calls I18nManager.forceRTL(true) when locale === 'ar'", () => {
    const manager = makeFakeManager(false);
    setManager(manager);
    RTL.applyRTLPolicy("ar");
    expect(manager.forceRTL).toHaveBeenCalledWith(true);
  });

  test("calls I18nManager.forceRTL(false) when locale === 'en'", () => {
    const manager = makeFakeManager(true);
    setManager(manager);
    RTL.applyRTLPolicy("en");
    expect(manager.forceRTL).toHaveBeenCalledWith(false);
  });

  test("calls I18nManager.forceRTL(false) for any non-'ar' locale (e.g. 'fr')", () => {
    const manager = makeFakeManager(true);
    setManager(manager);
    RTL.applyRTLPolicy("fr");
    expect(manager.forceRTL).toHaveBeenCalledWith(false);
  });

  test("treats empty-string locale as non-'ar' (forceRTL(false))", () => {
    const manager = makeFakeManager(true);
    setManager(manager);
    RTL.applyRTLPolicy("");
    expect(manager.forceRTL).toHaveBeenCalledWith(false);
  });

  test("silently no-ops when manager slot is null (RN-unavailable parity)", () => {
    setManager(null);
    expect(() => RTL.applyRTLPolicy("ar")).not.toThrow();
    expect(() => RTL.applyRTLPolicy("en")).not.toThrow();
  });

  test("silently swallows errors when allowRTL/forceRTL throw", () => {
    const manager: FakeI18nManager = {
      isRTL: false,
      allowRTL: jest.fn<void, [boolean]>(() => {
        throw new Error("boom");
      }),
      forceRTL: jest.fn<void, [boolean]>(() => {
        throw new Error("boom");
      }),
    };
    setManager(manager);
    expect(() => RTL.applyRTLPolicy("ar")).not.toThrow();
  });

  test("does not throw when manager exists but allowRTL/forceRTL are missing", () => {
    const partial = { isRTL: false } as unknown as FakeI18nManager;
    setManager(partial);
    expect(() => RTL.applyRTLPolicy("ar")).not.toThrow();
  });
});

describe("mobile-shell-rtl helpers — resolveIsRTL", () => {
  test("returns false when manager slot is null (RN-unavailable parity)", () => {
    setManager(null);
    expect(RTL.resolveIsRTL()).toBe(false);
  });

  test("returns false when I18nManager.isRTL === false", () => {
    setManager(makeFakeManager(false));
    expect(RTL.resolveIsRTL()).toBe(false);
  });

  test("returns true when I18nManager.isRTL === true", () => {
    setManager(makeFakeManager(true));
    expect(RTL.resolveIsRTL()).toBe(true);
  });
});

describe("mobile-shell-rtl helpers — resolveRowDirection", () => {
  test("returns 'row' in LTR (manager null)", () => {
    setManager(null);
    expect(RTL.resolveRowDirection()).toBe("row");
  });

  test("returns 'row' when I18nManager.isRTL === false", () => {
    setManager(makeFakeManager(false));
    expect(RTL.resolveRowDirection()).toBe("row");
  });

  test("returns 'row-reverse' when I18nManager.isRTL === true", () => {
    setManager(makeFakeManager(true));
    expect(RTL.resolveRowDirection()).toBe("row-reverse");
  });
});

describe("mobile-shell-rtl helpers — resolveTextStart / resolveTextEnd", () => {
  test("resolveTextStart returns 'left' in LTR", () => {
    setManager(makeFakeManager(false));
    expect(RTL.resolveTextStart()).toBe("left");
  });

  test("resolveTextStart returns 'right' in RTL", () => {
    setManager(makeFakeManager(true));
    expect(RTL.resolveTextStart()).toBe("right");
  });

  test("resolveTextEnd returns 'right' in LTR (mirror of textStart)", () => {
    setManager(makeFakeManager(false));
    expect(RTL.resolveTextEnd()).toBe("right");
  });

  test("resolveTextEnd returns 'left' in RTL (mirror of textStart)", () => {
    setManager(makeFakeManager(true));
    expect(RTL.resolveTextEnd()).toBe("left");
  });

  test("resolveTextStart returns LTR default when manager is null", () => {
    setManager(null);
    expect(RTL.resolveTextStart()).toBe("left");
  });

  test("resolveTextEnd returns LTR default when manager is null", () => {
    setManager(null);
    expect(RTL.resolveTextEnd()).toBe("right");
  });
});

describe("mobile-shell-rtl helpers — resolveMarginStart", () => {
  test("returns { marginLeft } in LTR", () => {
    setManager(makeFakeManager(false));
    expect(RTL.resolveMarginStart(8)).toEqual({ marginLeft: 8 });
  });

  test("returns { marginRight } in RTL", () => {
    setManager(makeFakeManager(true));
    expect(RTL.resolveMarginStart(8)).toEqual({ marginRight: 8 });
  });

  test("preserves the supplied numeric value (12 -> 12)", () => {
    setManager(makeFakeManager(true));
    expect(RTL.resolveMarginStart(12)).toEqual({ marginRight: 12 });
  });

  test("returns LTR { marginLeft } default when manager is null", () => {
    setManager(null);
    expect(RTL.resolveMarginStart(4)).toEqual({ marginLeft: 4 });
  });

  test("supports zero-value (edge case): { marginLeft: 0 } in LTR", () => {
    setManager(makeFakeManager(false));
    expect(RTL.resolveMarginStart(0)).toEqual({ marginLeft: 0 });
  });
});

describe("mobile-shell-rtl helpers — public hook surface", () => {
  test("hook exports are present (useIsRTL / useRowDirection / useTextStart / useTextEnd / useMarginStart)", () => {
    expect(typeof RTL.useIsRTL).toBe("function");
    expect(typeof RTL.useRowDirection).toBe("function");
    expect(typeof RTL.useTextStart).toBe("function");
    expect(typeof RTL.useTextEnd).toBe("function");
    expect(typeof RTL.useMarginStart).toBe("function");
  });
});
