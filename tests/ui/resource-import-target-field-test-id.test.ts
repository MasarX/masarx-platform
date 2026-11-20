import { sanitizeTargetFieldForTestId } from "../../packages/ui/src/resource-import/target-field-test-id";

test.each([
  ["", ""],
  ["-\u00a0.\u{1f642}---", ""],
  [" -A..B__C--/\u00e9-D- \n", "A--B__C----D"],
  ["\u212a/\u0130.A", "A"],
])("normalizes the resource import test ID part %j", (input, expected) => {
  expect(sanitizeTargetFieldForTestId(input)).toBe(expected);
});

test("normalizes a large resource import test ID within the CPU budget", () => {
  const hyphens = "-".repeat(40_000);
  const input = `--A.${hyphens}.B---`;
  const expected = `A-${hyphens}-B`;
  const start = process.cpuUsage();
  const result = sanitizeTargetFieldForTestId(input);
  const { user, system } = process.cpuUsage(start);

  expect(result).toBe(expected);
  expect(user + system).toBeLessThan(400_000);
});
