const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");
const inventoryPath = path.join(repoRoot, "docs/frontend/ROUTE_INVENTORY.md");

describe("frontend route inventory doc", () => {
  test("includes the portal mapping hub route and updated totals", () => {
    const body = fs.readFileSync(inventoryPath, "utf8");

    expect(body).toContain("| Portal  | 37          |");
    expect(body).toContain("| **Total** | **76**    |");
    expect(body).toContain("| `/catalog/service-offerings` | `ServiceCatalogPage`");
    expect(body).toContain("| `/integrations/mappings` | `PortalMappingsPage` | None | N/A | N/A | N/A | Y |");
    expect(body).toContain("| Signed-in route load (portal) | `portal-signed-in-coverage.spec.ts` | 30/30 |");
  });
});
