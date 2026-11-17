import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { AppShell } from "../../packages/ui/src/app-shell";
import { ResourceTable } from "../../packages/ui/src/resource-table";
import { renderWithIntl } from "./test-utils";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

test("app shell meets basic accessibility expectations", async () => {
  const { container } = render(
    <AppShell appName="Console">
      <div>Dashboard</div>
    </AppShell>
  );

  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

test("resource table meets basic accessibility expectations", async () => {
  const { container } = renderWithIntl(
    <ResourceTable
      columns={[
        { key: "id", label: "ID" },
        { key: "name", label: "Name" },
      ]}
      items={[
        { id: "1", name: "Alpha" },
        { id: "2", name: "Bravo" },
      ]}
      idKey="id"
    />
  );

  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
