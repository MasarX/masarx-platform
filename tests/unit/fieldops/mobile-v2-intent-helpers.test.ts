// Mobile V2 native-intent helper unit coverage.
//
// Engineering audit B1 (BLOCKER): the V2 shell's call / WhatsApp /
// navigate / copy / share handlers were toast-only stubs. These pure
// URL builders are the SSOT the real handlers use to launch the device
// intent — this suite covers every builder + the address composer.

import {
  buildMobileV2MapsUrl,
  buildMobileV2MapsUrlFromCoords,
  buildMobileV2TelUrl,
  buildMobileV2WhatsAppUrl,
  composeMobileV2AddressText,
  normalizeMobileV2PhoneDigits,
} from "../../../apps/fieldops/src/mobile-v2-intent-helpers";

describe("normalizeMobileV2PhoneDigits", () => {
  test("strips spaces / punctuation and the leading +", () => {
    expect(normalizeMobileV2PhoneDigits("+966 55 123 4567")).toBe("966551234567");
    expect(normalizeMobileV2PhoneDigits("+1 (415) 555-0100")).toBe("14155550100");
  });

  test("returns null for an empty / digitless / non-string input", () => {
    expect(normalizeMobileV2PhoneDigits("")).toBeNull();
    expect(normalizeMobileV2PhoneDigits("   ")).toBeNull();
    expect(normalizeMobileV2PhoneDigits("no-digits-here")).toBeNull();
    expect(normalizeMobileV2PhoneDigits(null)).toBeNull();
    expect(normalizeMobileV2PhoneDigits(undefined)).toBeNull();
  });
});

describe("buildMobileV2TelUrl", () => {
  test("builds a tel: URL from a formatted phone", () => {
    expect(buildMobileV2TelUrl("+966 55 ••• 0012".replace(/•/g, "0"))).toBe(
      "tel:966550000012",
    );
  });

  test("returns null when the phone has no usable digits", () => {
    expect(buildMobileV2TelUrl(null)).toBeNull();
    expect(buildMobileV2TelUrl("")).toBeNull();
  });
});

describe("buildMobileV2WhatsAppUrl", () => {
  test("builds a wa.me URL with no message", () => {
    expect(buildMobileV2WhatsAppUrl("+966551234567")).toBe(
      "https://wa.me/966551234567",
    );
  });

  test("appends a url-encoded text query when a message is supplied", () => {
    expect(buildMobileV2WhatsAppUrl("+966551234567", "On my way")).toBe(
      "https://wa.me/966551234567?text=On%20my%20way",
    );
  });

  test("ignores a blank message", () => {
    expect(buildMobileV2WhatsAppUrl("+966551234567", "   ")).toBe(
      "https://wa.me/966551234567",
    );
  });

  test("returns null when the phone has no usable digits", () => {
    expect(buildMobileV2WhatsAppUrl(null)).toBeNull();
  });
});

describe("buildMobileV2MapsUrl", () => {
  test("builds a Google Maps directions URL for a free-text address", () => {
    expect(buildMobileV2MapsUrl("Al Murooj 4419, Riyadh")).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=Al%20Murooj%204419%2C%20Riyadh&travelmode=driving",
    );
  });

  test("returns null for an empty / non-string destination", () => {
    expect(buildMobileV2MapsUrl("")).toBeNull();
    expect(buildMobileV2MapsUrl("   ")).toBeNull();
    expect(buildMobileV2MapsUrl(null)).toBeNull();
    expect(buildMobileV2MapsUrl(undefined)).toBeNull();
  });
});

describe("buildMobileV2MapsUrlFromCoords", () => {
  test("builds a directions URL for a lat,lng pair", () => {
    expect(buildMobileV2MapsUrlFromCoords(24.7136, 46.6753)).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=24.7136%2C46.6753&travelmode=driving",
    );
  });

  test("returns null when either coordinate is non-finite", () => {
    expect(buildMobileV2MapsUrlFromCoords(Number.NaN, 46.6753)).toBeNull();
    expect(buildMobileV2MapsUrlFromCoords(24.7136, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("composeMobileV2AddressText", () => {
  test("joins address lines with a middle dot", () => {
    expect(
      composeMobileV2AddressText({
        addressLines: ["Al Murooj 4419", "Apt 12"],
      }),
    ).toBe("Al Murooj 4419 · Apt 12");
  });

  test("appends the note and tracking code on their own lines", () => {
    expect(
      composeMobileV2AddressText({
        addressLines: ["Al Murooj 4419"],
        addressNote: "3rd floor — no elevator",
        trackingCode: "STP-003",
      }),
    ).toBe("Al Murooj 4419\n3rd floor — no elevator\nSTP-003");
  });

  test("drops blank lines / note / tracking", () => {
    expect(
      composeMobileV2AddressText({
        addressLines: ["  ", "Al Olaya", ""],
        addressNote: "   ",
        trackingCode: "",
      }),
    ).toBe("Al Olaya");
  });

  test("returns an empty string when there is nothing to compose", () => {
    expect(
      composeMobileV2AddressText({ addressLines: [], addressNote: null }),
    ).toBe("");
  });
});
