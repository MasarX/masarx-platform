import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RelatedResourceTableClient } from "../../packages/ui/src/related-resource-table-client";
import { renderWithIntl } from "./test-utils";

const reorderResourceMock = jest.fn();

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({ reorderResource: reorderResourceMock }),
}));

jest.mock("../../packages/ui/src/resource-table", () => ({
  ResourceTable: () => null,
}));

beforeEach(() => {
  reorderResourceMock.mockReset();
});

test("related resource table reorders via move buttons", async () => {
  const user = userEvent.setup();
  reorderResourceMock.mockResolvedValue({
    status: "reordered",
    resource: "workflow_template_steps",
    count: 2,
  });

  renderWithIntl(
    <RelatedResourceTableClient
      resourceKey="workflow_template_steps"
      columns={[]}
      items={[
        { id: "a", sequence_order: 1, operation_name: "First step" },
        { id: "b", sequence_order: 2, operation_name: "Second step" },
      ]}
      idKey="id"
      baseHref="/console/resources/workflow_template_steps?workflow_template_id=template-1"
      appBasePath="/console"
      reorder={{ order_column: "sequence_order" }}
      capabilities={["workflow_runs.write"]}
      capabilityWrite="workflow_runs.write"
      emptyMessage="Empty"
    />
  );

  await user.click(screen.getByRole("button", { name: "Reorder" }));

  const moveDownButtons = screen.getAllByLabelText("Move down");
  await user.click(moveDownButtons[0]);

  await user.click(screen.getByRole("button", { name: "Save order" }));

  await waitFor(() =>
    expect(reorderResourceMock).toHaveBeenCalledWith({
      resource: "workflow_template_steps",
      ids: ["b", "a"],
    })
  );
});
