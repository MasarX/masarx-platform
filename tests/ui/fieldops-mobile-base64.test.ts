import {
  decodeBase64ToArrayBuffer,
  normalizeBase64Payload,
} from "../../apps/fieldops/src/mobile-base64";

function decodeBytes(buffer: ArrayBuffer) {
  return new TextDecoder().decode(new Uint8Array(buffer));
}

test("normalizeBase64Payload strips data-uri prefixes and restores missing padding", () => {
  expect(normalizeBase64Payload("data:image/jpeg;base64,SGVsbG8")).toBe("SGVsbG8=");
});

test("normalizeBase64Payload converts url-safe alphabet to standard base64", () => {
  expect(normalizeBase64Payload("ab-c_d")).toBe("ab+c/d==");
});

test("decodeBase64ToArrayBuffer accepts data-uri encoded payloads", () => {
  const decoded = decodeBase64ToArrayBuffer("data:image/jpeg;base64,SGVsbG8=");
  expect(decodeBytes(decoded)).toBe("Hello");
});
