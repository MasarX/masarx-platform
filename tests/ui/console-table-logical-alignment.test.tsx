import * as fs from "node:fs";
import * as path from "node:path";
import { render } from "@testing-library/react";
import { IntegrationHealth } from "../../packages/ui/src/integrations/integration-health";

/**
 * Tables on route workspace, integration health and onboarding/organization
 * readiness align with logical utilities (text-start/text-end), so their
 * columns mirror under dir="rtl".
 */

const PHYSICAL_ALIGNMENT = /\btext-(left|right)\b/;

const TABLE_SOURCES = [
  "packages/ui/src/route-operations-workspace-page.tsx",
  "packages/ui/src/integrations/integration-health.tsx",
  "packages/ui/src/onboarding-readiness-page.tsx",
];

test.each(TABLE_SOURCES)("%s uses no physical text alignment", (file) => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8");
  expect(source).not.toMatch(PHYSICAL_ALIGNMENT);
});

test("integration health table cells align to logical edges in RTL", () => {
  const { container } = render(
    <div dir="rtl">
      <IntegrationHealth
        integrations={[
          { id: "int-1", name: "Synthetic Carrier", type: "api", status: "healthy", successRate: 99, totalCalls: 12, avgResponseMs: 80 },
        ]}
      />
    </div>,
  );

  const cells = Array.from(container.querySelectorAll("th, td"));
  expect(cells.length).toBeGreaterThan(0);
  for (const cell of cells) {
    expect(cell.className).not.toMatch(PHYSICAL_ALIGNMENT);
  }
  const headers = Array.from(container.querySelectorAll("th"));
  expect(headers[0].className).toContain("text-start");
  expect(headers.slice(3).every((th) => th.className.includes("text-end"))).toBe(true);
});
