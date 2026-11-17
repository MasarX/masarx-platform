import { fireEvent, screen } from "@testing-library/react";
import { AccessPolicyEditor } from "../../packages/ui/src/access-policy-editor";
import { renderWithIntl } from "./test-utils";

const basePolicy = {
  version: 1,
  capabilities: [{ key: "shipments.read", label: "Shipments read" }],
  roles: [
    {
      key: "viewer",
      label: "Viewer",
      capability_keys: ["shipments.read"],
    },
  ],
  assignments: {
    user_type: {
      client_admin: ["viewer"],
    },
  },
};

test("access policy editor adds roles and capabilities", () => {
  let latestPolicy: any = null;
  renderWithIntl(
    <AccessPolicyEditor
      policy={basePolicy}
      onChange={(next) => {
        latestPolicy = next;
      }}
      testIdPrefix="policy"
    />
  );

  fireEvent.change(screen.getByLabelText("Role key"), {
    target: { value: "ops" },
  });
  fireEvent.change(screen.getByLabelText("Role label"), {
    target: { value: "Ops" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add role" }));

  expect(latestPolicy?.roles?.some((role: any) => role.key === "ops")).toBe(
    true
  );

  fireEvent.change(screen.getByLabelText("Capability key"), {
    target: { value: "labels.download" },
  });
  fireEvent.change(screen.getByLabelText("Capability label"), {
    target: { value: "Labels download" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add capability" }));

  expect(
    latestPolicy?.capabilities?.some(
      (capability: any) => capability.key === "labels.download"
    )
  ).toBe(true);
});

test("access policy editor adds deny overrides", () => {
  let latestPolicy: any = null;
  renderWithIntl(
    <AccessPolicyEditor
      policy={basePolicy}
      onChange={(next) => {
        latestPolicy = next;
      }}
      testIdPrefix="policy"
    />
  );

  fireEvent.change(screen.getByLabelText("Deny capability key"), {
    target: { value: "shipments.delete" },
  });
  fireEvent.change(screen.getByLabelText("Deny scope type"), {
    target: { value: "tenant" },
  });
  fireEvent.change(screen.getByLabelText("Deny scope id"), {
    target: { value: "tenant-123" },
  });
  fireEvent.change(screen.getByLabelText("Deny reason"), {
    target: { value: "Read-only window" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add deny" }));

  expect(
    latestPolicy?.denies?.some(
      (deny: any) => deny.capability_key === "shipments.delete"
    )
  ).toBe(true);
});
