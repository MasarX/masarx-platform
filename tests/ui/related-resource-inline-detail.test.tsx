import { fireEvent, screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { RelatedResourceInlineDetail } from "../../packages/ui/src/related-resource-inline-detail";

test("shows lookup labels for related-resource inline detail values and editors", () => {
  const clientId = "11111111-1111-1111-1111-111111111111";

  renderWithIntl(
    <RelatedResourceInlineDetail
      resourceKey="shipments"
      columns={[
        {
          key: "client_lookup",
          label: "Client",
          editMode: "inline",
          editType: "uuid",
          editOptions: [{ label: "Demo Client A", value: clientId }],
        },
      ]}
      item={{ id: "shipment-1", client_lookup: clientId }}
      idKey="id"
      baseHref="/console/resources/shipments?id=shipment-1"
      capabilities={["shipments.write"]}
      capabilityWrite="shipments.write"
      testIdPrefix="related-detail"
    />
  );

  expect(screen.getByText("Demo Client A")).toBeInTheDocument();
  expect(screen.queryByText(clientId)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));

  expect(screen.getByRole("combobox")).toBeInTheDocument();
  expect(screen.getByText("Demo Client A")).toBeInTheDocument();
});
