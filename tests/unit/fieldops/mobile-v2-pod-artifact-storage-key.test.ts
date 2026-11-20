import { buildMobileV2PodArtifactStorageKey } from "../../../apps/fieldops/src/mobile-v2-pod-artifacts";

function storageKey(uniqueId: string, extension = " .PNG ") {
  return buildMobileV2PodArtifactStorageKey({
    organizationId: "org",
    routeStopId: "stop",
    kind: "photo",
    extension,
    uniqueId,
  });
}

test.each([
  ["", "artifact"],
  ["-\u{1f642}---", "artifact"],
  [" \u00a0--File__A---B-\u00e9 \n", "file__a---b"],
  ["\u212a/\u0130", "k-i"],
])("normalizes the POD artifact path part %j", (input, expected) => {
  expect(storageKey(input)).toBe(`org/pod/stop/photo-${expected}.png`);
});

test("normalizes a large POD artifact path part within the CPU budget", () => {
  const hyphens = "-".repeat(40_000);
  const input = `--A${hyphens}B---`;
  const expected = `org/pod/stop/photo-a${hyphens}b.png`;
  const start = process.cpuUsage();
  const result = storageKey(input);
  const { user, system } = process.cpuUsage(start);

  expect(result).toBe(expected);
  expect(user + system).toBeLessThan(400_000);
});
