import { resolveDriverSafetyUiMode } from "../../apps/fieldops/src/driver-safety-lock-stages";

test.each([
  [0, "full"], [4.99, "full"], [5, "text_only"], [25, "suppressed"], [null, "suppressed"],
] as const)("applies the new route-offer display stage at %s kph", (speed, mode) => {
  expect(resolveDriverSafetyUiMode(speed, undefined)).toBe(mode);
});

test("suppresses offers for an ambiguous or missing configured stage", () => {
  const entry = { speed_min_kph: 0, speed_max_kph: 8, ui_mode: "text_only" };
  expect(resolveDriverSafetyUiMode(3, [entry])).toBe("text_only");
  expect(resolveDriverSafetyUiMode(3, [entry, { ...entry, ui_mode: "full" }])).toBe("suppressed");
  expect(resolveDriverSafetyUiMode(8, [entry])).toBe("suppressed");
});
