import { formatRuntimeConsoleMessage, isNoiseRuntimeConsoleMessage } from "../e2e/utils/runtime-errors";

describe("runtime error console noise filter", () => {
  it("filters known preview feedback script CSP noise", () => {
    const message =
      "Loading the script 'https://vercel.live/_next-live/feedback/feedback.js' violates the following Content Security Policy directive: \"script-src 'self' 'unsafe-inline'\".";
    expect(isNoiseRuntimeConsoleMessage(message)).toBe(true);
  });

  it("filters generic 404 only for vercel feedback script location", () => {
    const message = "Failed to load resource: the server responded with a status of 404 ()";
    expect(
      isNoiseRuntimeConsoleMessage(message, {
        locationUrl: "https://vercel.live/_next-live/feedback/feedback.js",
      })
    ).toBe(true);
  });

  it("does not filter unrelated 404 noise by default", () => {
    const message = "Failed to load resource: the server responded with a status of 404 ()";
    expect(isNoiseRuntimeConsoleMessage(message)).toBe(false);
  });

  it("filters 401 noise for ui-event endpoint only", () => {
    const message = "Failed to load resource: the server responded with a status of 401 ()";
    expect(
      isNoiseRuntimeConsoleMessage(message, {
        locationUrl: "https://itjlkxpxvtqxuuvnrwutzjni.example.invalid/api/ui-event",
      })
    ).toBe(true);
  });

  it("does not filter 401 noise for non ui-event endpoints", () => {
    const message = "Failed to load resource: the server responded with a status of 401 ()";
    expect(
      isNoiseRuntimeConsoleMessage(message, {
        locationUrl: "https://htjtqukhjznyyzxwijvshmil.example.invalid/rest/v1/shipments",
      })
    ).toBe(false);
  });

  it("does not filter app runtime errors", () => {
    expect(isNoiseRuntimeConsoleMessage("TypeError: Cannot read properties of undefined")).toBe(
      false
    );
  });

  it("reports the resource and page paths without URL credentials or query data", () => {
    expect(
      formatRuntimeConsoleMessage("Failed to load resource: 500", {
        locationUrl: "https://fixture@console.example.invalid/api/ui-event?sample=1#fragment",
        pageUrl: "https://console.example.invalid/operations/pickups/waves",
      }),
    ).toBe("Failed to load resource: 500 [/api/ui-event /operations/pickups/waves]");
  });
});
