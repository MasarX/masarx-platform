import { AR_STRINGS, EN_STRINGS } from "../../apps/fieldops/src/i18n";

function catalogShape(value: unknown, key: string): unknown {
  if (typeof value === "function") return "formatter";
  if (typeof value === "string") {
    if (!value.trim()) throw new Error("Empty locale message at " + key);
    return "text";
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [name, catalogShape(entry, key + "." + name)])
    );
  }
  throw new Error("Unsupported locale message at " + key);
}

test("English and Arabic FieldOps catalogs have matching nonempty entries", () => {
  expect(catalogShape(AR_STRINGS, "ar")).toEqual(catalogShape(EN_STRINGS, "en"));
});
