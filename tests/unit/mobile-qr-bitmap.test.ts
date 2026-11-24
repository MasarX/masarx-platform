import { buildSigningQr } from "../../apps/fieldops/src/mobile-qr-bitmap";

test("renders dark modules with a four-module quiet zone and a payload-specific pattern", () => {
  const url = "https://signing.example.invalid/delivery-signing#token=";
  const first = buildSigningQr(url + "a".repeat(64));
  const second = buildSigningQr(url + "b".repeat(64));
  expect(first.size).toBeGreaterThan(29);
  expect(first.path).toContain("M4 4h1v1h-1z");
  expect(first.path).not.toBe(second.path);
  for (const [, column, row] of first.path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    expect(Number(column)).toBeGreaterThanOrEqual(4);
    expect(Number(row)).toBeGreaterThanOrEqual(4);
    expect(Number(column)).toBeLessThan(first.size - 4);
    expect(Number(row)).toBeLessThan(first.size - 4);
  }
});
