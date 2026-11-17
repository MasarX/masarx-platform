import * as React from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServiceCatalogForm } from "../../packages/ui/src/service-catalog-form";
import { renderWithIntl } from "./test-utils";

const refresh = jest.fn();
const toast = jest.fn();
const createServiceLevel = jest.fn();
const createServiceOffering = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

jest.mock("@masarx/api", () => {
  const actual = jest.requireActual("@masarx/api");
  return {
    ...actual,
    createUiClient: () => ({ createServiceLevel, createServiceOffering }),
  };
});

jest.mock("../../packages/ui/src/use-toast", () => {
  const actual = jest.requireActual("../../packages/ui/src/use-toast");
  return {
    ...actual,
    useToast: () => ({ toast }),
  };
});

const baseProps = {
  organizationId: "org-1",
  capabilities: ["agreements.write"],
  capabilityWrite: "agreements.write",
  levels: [{ id: "level-1", key: "standard", name: "Standard", isActive: true }],
  offerings: [],
  branches: [
    { id: "branch-1", name: "Riyadh" },
    { id: "branch-2", name: "Jeddah" },
  ],
  zones: [
    { id: "zone-1", name: "North", branchId: "branch-1" },
    { id: "zone-2", name: "West", branchId: "branch-2" },
  ],
};

beforeEach(() => {
  refresh.mockReset();
  toast.mockReset();
  createServiceLevel.mockReset();
  createServiceOffering.mockReset();
  createServiceLevel.mockResolvedValue({ ok: true, service_level_id: "level-2" });
  createServiceOffering.mockResolvedValue({ ok: true, service_offering_id: "offering-1" });
});

test("creates a service level with a canonical lookup key", async () => {
  const user = userEvent.setup();
  renderWithIntl(<ServiceCatalogForm {...baseProps} />);

  await user.type(screen.getByTestId("service-catalog-level-name"), "Express");
  await user.click(screen.getByTestId("service-catalog-level-submit"));

  await waitFor(() => expect(createServiceLevel).toHaveBeenCalledWith({
    organizationId: "org-1",
    key: "express",
    name: "Express",
    description: null,
  }));
  expect(refresh).toHaveBeenCalled();
});

test("creates an offering from canonical level, branch, and zone rows", async () => {
  const user = userEvent.setup();
  renderWithIntl(<ServiceCatalogForm {...baseProps} />);

  await user.selectOptions(screen.getByTestId("service-catalog-offering-level"), "level-1");
  await user.selectOptions(screen.getByTestId("service-catalog-offering-branch"), "branch-1");
  await user.selectOptions(screen.getByTestId("service-catalog-offering-zone"), "zone-1");
  await user.type(screen.getByTestId("service-catalog-offering-name"), "Riyadh Standard");
  await user.clear(screen.getByTestId("service-catalog-offering-priority"));
  await user.type(screen.getByTestId("service-catalog-offering-priority"), "10");
  await user.click(screen.getByTestId("service-catalog-offering-submit"));

  await waitFor(() => expect(createServiceOffering).toHaveBeenCalledWith({
    organizationId: "org-1",
    serviceLevelId: "level-1",
    branchId: "branch-1",
    zoneId: "zone-1",
    priority: 10,
    metadata: { display: { name: "Riyadh Standard" } },
  }));
  expect(refresh).toHaveBeenCalled();
});

test("filters zones by branch and clears an incompatible selection", async () => {
  const user = userEvent.setup();
  renderWithIntl(<ServiceCatalogForm {...baseProps} />);

  const zoneSelect = screen.getByTestId("service-catalog-offering-zone");
  expect(zoneSelect).toBeDisabled();

  await user.selectOptions(screen.getByTestId("service-catalog-offering-branch"), "branch-1");
  expect(screen.getByRole("option", { name: "North" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "West" })).not.toBeInTheDocument();
  await user.selectOptions(zoneSelect, "zone-1");

  await user.selectOptions(screen.getByTestId("service-catalog-offering-branch"), "branch-2");
  expect(zoneSelect).toHaveValue("");
  expect(screen.queryByRole("option", { name: "North" })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "West" })).toBeInTheDocument();
});

test("keeps catalog mutation unavailable without the canonical write capability", async () => {
  renderWithIntl(
    <ServiceCatalogForm {...baseProps} capabilities={["agreements.read"]} />
  );

  expect(screen.getByTestId("service-catalog-level-submit")).toBeDisabled();
  expect(screen.getByTestId("service-catalog-offering-submit")).toBeDisabled();
  expect(createServiceLevel).not.toHaveBeenCalled();
  expect(createServiceOffering).not.toHaveBeenCalled();
});
