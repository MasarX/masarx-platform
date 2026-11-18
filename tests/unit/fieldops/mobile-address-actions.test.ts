import * as fs from "node:fs";
import * as path from "node:path";
import {
  composeStopAddressText,
  runStopAddressAction,
} from "../../../apps/fieldops/src/mobile-address-actions";

describe("FieldOps PWA address intents", () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const copy = jest.fn();
  const share = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: copy }, share },
    });
  });
  afterEach(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  });

  test("composes only the displayed address, instructions and reference", () => {
    expect(composeStopAddressText({
      address: " 10 Test Street ", note: " Gate B ", reference: " REF-42 ",
    })).toBe("10 Test Street\nGate B\nREF-42");
    expect(composeStopAddressText({ address: "10 Test Street" })).toBe("10 Test Street");
    expect(composeStopAddressText({ address: " ", note: "Gate B", reference: "REF-42" }))
      .toBeNull();
  });

  test.each(["copy", "share"] as const)("does not run %s without an address", async (action) => {
    expect(await runStopAddressAction(action, null)).toBe("missing");
    expect(await runStopAddressAction(action, "  ")).toBe("missing");
    expect(copy).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  test("copies through the existing browser clipboard helper", async () => {
    copy.mockResolvedValue(undefined);
    expect(await runStopAddressAction("copy", "Address\nInstructions\nREF-42")).toBe("copied");
    expect(copy).toHaveBeenCalledWith("Address\nInstructions\nREF-42");
    expect(share).not.toHaveBeenCalled();
  });

  test("shares text only, directly in the initiating call", async () => {
    share.mockResolvedValue(undefined);
    const result = runStopAddressAction("share", "Address");
    expect(share).toHaveBeenCalledWith({ text: "Address" });
    expect(await result).toBe("shared");
    expect(copy).not.toHaveBeenCalled();
  });

  test.each(["copy", "share"] as const)("waits for %s to resolve", async (action) => {
    let finish!: () => void;
    (action === "copy" ? copy : share).mockReturnValue(new Promise<void>((resolve) => {
      finish = resolve;
    }));
    let settled = false;
    const result = runStopAddressAction(action, "Address").then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect(await result).toBe(action === "copy" ? "copied" : "shared");
  });

  test.each(["copy", "share"] as const)("does not claim success when %s is denied", async (action) => {
    (action === "copy" ? copy : share).mockRejectedValue(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    expect(await runStopAddressAction(action, "Address")).toBe("failed");
  });

  test("does not copy when the user cancels Share", async () => {
    share.mockRejectedValue(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    expect(await runStopAddressAction("share", "Private address")).toBe("cancelled");
    expect(copy).not.toHaveBeenCalled();
  });

  test("unsupported Share never implicitly copies", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: copy } } });
    expect(await runStopAddressAction("share", "Address")).toBe("unsupported");
    expect(copy).not.toHaveBeenCalled();
  });

  test("returns unsupported outside a browser instead of invoking native sharing", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
    expect(await runStopAddressAction("copy", "Address")).toBe("unsupported");
    expect(await runStopAddressAction("share", "Address")).toBe("unsupported");
  });

  test("wires only displayed data into the current PWA route-detail surface and its existing lock", () => {
    // Normalize autocrlf checkouts so the multi-line JSX assertion is platform-neutral.
    const source = fs.readFileSync(path.resolve("apps/fieldops/App.tsx"), "utf8").replace(/\r\n/g, "\n");
    const block = source.slice(source.indexOf('<StopAddressActions'), source.indexOf('/>', source.indexOf('<StopAddressActions')));
    expect(block).toContain("address={stop.fullAddress ?? stop.addressSummary}");
    expect(block).toContain("note={stop.notes}");
    expect(block).toContain("reference={stop.reference}");
    expect(block).toContain("disabled={interactionLocked || isExecutingRouteAction}");
    expect(block).toContain("runAction={withRouteActionLock}");
    expect(block).toContain("strings={addressActionStrings}");
    expect(source).toContain('Platform.OS === "web" ? (\n          <StopAddressActions');
    expect(source).toContain("addressActionStrings={strings.addressActions}");
    expect(block).not.toContain("detail=");
  });
});
