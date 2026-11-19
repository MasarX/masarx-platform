import {
  MOBILE_V2_ICONS,
  MOBILE_V2_ICON_DEFAULT_SIZE,
  MOBILE_V2_ICON_DEFAULT_STROKE,
  MOBILE_V2_ICON_NAMES,
  MOBILE_V2_ICON_VIEWBOX,
  MOBILE_V2_ICON_VIEWBOX_SIZE,
  type MobileV2IconName,
  type MobileV2IconShape,
  getMobileV2IconSpec,
  resolveMobileV2IconName,
} from "../../../apps/fieldops/src/mobile-v2-icon-specs";

const VIEWBOX = MOBILE_V2_ICON_VIEWBOX_SIZE; // 24

describe("mobile-v2 icon specs — catalog", () => {
  test("name list is non-empty and unique", () => {
    expect(MOBILE_V2_ICON_NAMES.length).toBeGreaterThan(0);
    expect(new Set(MOBILE_V2_ICON_NAMES).size).toBe(MOBILE_V2_ICON_NAMES.length);
  });

  test("name list matches the design source 60+ icon set", () => {
    expect(MOBILE_V2_ICON_NAMES.length).toBeGreaterThanOrEqual(60);
  });

  test("every name has a corresponding spec entry", () => {
    for (const name of MOBILE_V2_ICON_NAMES) {
      expect(MOBILE_V2_ICONS).toHaveProperty(name);
      expect(MOBILE_V2_ICONS[name].length).toBeGreaterThan(0);
    }
  });

  test("ICON map has no extra keys outside the name list", () => {
    const declared = new Set(MOBILE_V2_ICON_NAMES as ReadonlyArray<string>);
    for (const key of Object.keys(MOBILE_V2_ICONS)) {
      expect(declared.has(key)).toBe(true);
    }
  });

  test("every essential operations icon is present", () => {
    const required: ReadonlyArray<MobileV2IconName> = [
      "menu",
      "arrow-left",
      "search",
      "filter",
      "scan",
      "qr",
      "truck",
      "package",
      "route",
      "navigate",
      "pin",
      "phone",
      "whatsapp",
      "camera",
      "sig",
      "cash",
      "wifi-off",
      "sync",
      "cloud-up",
      "cloud-check",
      "alert",
      "info",
      "user",
      "logout",
      "settings",
      "list",
      "map",
    ];
    for (const name of required) {
      expect(MOBILE_V2_ICONS).toHaveProperty(name);
    }
  });
});

describe("mobile-v2 icon specs — geometry", () => {
  const inViewBox = (n: number) => n >= -1 && n <= VIEWBOX + 1;

  test("viewBox constants match design source (0 0 24 24)", () => {
    expect(MOBILE_V2_ICON_VIEWBOX).toBe("0 0 24 24");
    expect(MOBILE_V2_ICON_VIEWBOX_SIZE).toBe(24);
  });

  test("default render hints match design source defaults (size=20, stroke=1.7)", () => {
    expect(MOBILE_V2_ICON_DEFAULT_SIZE).toBe(20);
    expect(MOBILE_V2_ICON_DEFAULT_STROKE).toBe(1.7);
  });

  test("every shape kind is one of the supported set", () => {
    const allowedKinds = new Set(["path", "rect", "circle"]);
    for (const name of MOBILE_V2_ICON_NAMES) {
      for (const shape of MOBILE_V2_ICONS[name]) {
        expect(allowedKinds.has(shape.kind)).toBe(true);
      }
    }
  });

  test("path shapes have a non-empty d attribute starting with a valid command", () => {
    const validStart = /^[MmLlHhVvCcSsQqTtAaZz]/;
    for (const name of MOBILE_V2_ICON_NAMES) {
      for (const shape of MOBILE_V2_ICONS[name]) {
        if (shape.kind === "path") {
          expect(shape.d.length).toBeGreaterThan(0);
          expect(validStart.test(shape.d.trim())).toBe(true);
        }
      }
    }
  });

  test("rect shapes have non-zero size and reasonable bounds", () => {
    for (const name of MOBILE_V2_ICON_NAMES) {
      for (const shape of MOBILE_V2_ICONS[name]) {
        if (shape.kind === "rect") {
          expect(shape.width).toBeGreaterThan(0);
          expect(shape.height).toBeGreaterThan(0);
          expect(inViewBox(shape.x)).toBe(true);
          expect(inViewBox(shape.y)).toBe(true);
          expect(inViewBox(shape.x + shape.width)).toBe(true);
          expect(inViewBox(shape.y + shape.height)).toBe(true);
          if (shape.rx !== undefined) {
            expect(shape.rx).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  test("circle shapes have positive radius and centers in viewBox", () => {
    for (const name of MOBILE_V2_ICON_NAMES) {
      for (const shape of MOBILE_V2_ICONS[name]) {
        if (shape.kind === "circle") {
          expect(shape.r).toBeGreaterThan(0);
          expect(inViewBox(shape.cx)).toBe(true);
          expect(inViewBox(shape.cy)).toBe(true);
        }
      }
    }
  });

  test("only whatsapp interior and dot use fill='currentColor'", () => {
    const filled: Array<{ name: MobileV2IconName; shape: MobileV2IconShape }> = [];
    for (const name of MOBILE_V2_ICON_NAMES) {
      for (const shape of MOBILE_V2_ICONS[name]) {
        if ("fill" in shape && shape.fill === "currentColor") {
          filled.push({ name, shape });
        }
      }
    }
    const filledNames = filled.map(({ name }) => name).sort();
    expect(filledNames).toEqual(["dot", "whatsapp"]);
  });
});

describe("mobile-v2 icon specs — resolvers", () => {
  test("resolveMobileV2IconName accepts known names", () => {
    expect(resolveMobileV2IconName("menu")).toBe("menu");
    expect(resolveMobileV2IconName("scan")).toBe("scan");
    expect(resolveMobileV2IconName("wifi-off")).toBe("wifi-off");
  });

  test("resolveMobileV2IconName trims whitespace", () => {
    expect(resolveMobileV2IconName("  menu  ")).toBe("menu");
  });

  test("resolveMobileV2IconName returns null for unknown / non-string", () => {
    expect(resolveMobileV2IconName("not-an-icon")).toBeNull();
    expect(resolveMobileV2IconName("")).toBeNull();
    expect(resolveMobileV2IconName(undefined)).toBeNull();
    expect(resolveMobileV2IconName(null)).toBeNull();
    expect(resolveMobileV2IconName(123)).toBeNull();
    expect(resolveMobileV2IconName({})).toBeNull();
  });

  test("getMobileV2IconSpec returns the spec array for known names", () => {
    const spec = getMobileV2IconSpec("menu");
    expect(spec).not.toBeNull();
    expect(Array.isArray(spec)).toBe(true);
    expect(spec).toHaveLength(1);
  });

  test("getMobileV2IconSpec returns null for unknown names", () => {
    expect(getMobileV2IconSpec("nope")).toBeNull();
    expect(getMobileV2IconSpec(undefined)).toBeNull();
  });
});

describe("mobile-v2 icon specs — known per-icon shapes (regression guards)", () => {
  test("box has rect + path", () => {
    const spec = MOBILE_V2_ICONS.box;
    expect(spec).toHaveLength(2);
    expect(spec[0]?.kind).toBe("rect");
    expect(spec[1]?.kind).toBe("path");
  });

  test("truck has rect + path + 2 circles (wheels)", () => {
    const spec = MOBILE_V2_ICONS.truck;
    expect(spec).toHaveLength(4);
    const circleCount = spec.filter((s) => s.kind === "circle").length;
    expect(circleCount).toBe(2);
  });

  test("qr has 3 rects (corner registration squares) + 1 path", () => {
    const spec = MOBILE_V2_ICONS.qr;
    const rectCount = spec.filter((s) => s.kind === "rect").length;
    expect(rectCount).toBe(3);
  });

  test("locate has two concentric circles (radius 3 inner, 8 outer)", () => {
    const spec = MOBILE_V2_ICONS.locate;
    const circles = spec.filter((s) => s.kind === "circle") as Extract<
      MobileV2IconShape,
      { kind: "circle" }
    >[];
    expect(circles.length).toBeGreaterThanOrEqual(2);
    const radii = circles.map((c) => c.r).sort((a, b) => a - b);
    expect(radii[0]).toBe(3);
    expect(radii[radii.length - 1]).toBe(8);
  });

  test("dot is a single filled circle at the center", () => {
    const spec = MOBILE_V2_ICONS.dot;
    expect(spec).toHaveLength(1);
    const shape = spec[0];
    expect(shape?.kind).toBe("circle");
    if (shape?.kind === "circle") {
      expect(shape.cx).toBe(12);
      expect(shape.cy).toBe(12);
      expect(shape.fill).toBe("currentColor");
    }
  });

  test("wifi-off has 4 path elements (slash + arcs + dot)", () => {
    const spec = MOBILE_V2_ICONS["wifi-off"];
    expect(spec).toHaveLength(4);
    for (const shape of spec) {
      expect(shape.kind).toBe("path");
    }
  });
});
