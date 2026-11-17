import {
  normalizeAppHref,
  normalizeBasePath,
  normalizePath,
  stripBasePath,
} from "../../packages/ui/src/navigation-paths";

describe("navigation paths", () => {
  test("normalizeBasePath trims and normalizes", () => {
    expect(normalizeBasePath()).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("console")).toBe("/console");
    expect(normalizeBasePath("/console/")).toBe("/console");
  });

  test("stripBasePath removes base path prefix", () => {
    expect(stripBasePath("/console/resources/shipments", "/console")).toBe(
      "/resources/shipments"
    );
    expect(stripBasePath("console/resources/shipments", "/console")).toBe(
      "/resources/shipments"
    );
    expect(
      stripBasePath("/console/resources/shipments?x=1#y", "/console")
    ).toBe("/resources/shipments?x=1#y");
  });

  test("stripBasePath returns original href when base path does not match", () => {
    expect(stripBasePath("/portal/resources/shipments", "/console")).toBe(
      "/portal/resources/shipments"
    );
    expect(stripBasePath("/resources/shipments", "/console")).toBe(
      "/resources/shipments"
    );
  });

  test("normalizeAppHref dedupes leading segments and basePath doubles", () => {
    expect(normalizeAppHref("resources/shipments", "/console")).toBe(
      "/resources/shipments"
    );
    expect(normalizeAppHref("/console/console/resources/shipments", "/console")).toBe(
      "/console/resources/shipments"
    );
    expect(normalizeAppHref("/resources/resources", "/console")).toBe(
      "/resources"
    );
  });

  test("normalizeAppHref strips legacy app prefixes for root-served hosts", () => {
    expect(normalizeAppHref("/console/resources/shipments", "")).toBe(
      "/resources/shipments"
    );
    expect(normalizeAppHref("/portal/resources/labels?view=all", "")).toBe(
      "/resources/labels?view=all"
    );
    expect(normalizeAppHref("/console", "")).toBe("/");
    expect(normalizeAppHref("/portal", "")).toBe("/");
  });

  test("normalizePath strips hash/query and basePath prefix", () => {
    expect(normalizePath("/console/resources/shipments/", "/console")).toBe(
      "/resources/shipments"
    );
    expect(
      normalizePath("/console/resources/shipments/?q=1#hash", "/console")
    ).toBe("/resources/shipments");
  });
});
