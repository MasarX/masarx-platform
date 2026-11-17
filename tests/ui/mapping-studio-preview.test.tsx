import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MappingStudioPage } from "../../packages/ui/src/mapping-studio-page";

const mockUi = {
  readRegistry: jest.fn().mockResolvedValue({ resources: [] }),
  mappingStudio: { preview: jest.fn().mockResolvedValue({ review: {} }) },
};
jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => mockUi,
}));
jest.mock("../../packages/ui/src/use-toast", () => ({ useToast: () => ({ toast: jest.fn() }) }));

test("Mapping Studio reviews the bounded preview returned by the real file parser", async () => {
  render(<MappingStudioPage appBasePath="/console" initialArtifact="tabular_import" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Parse / infer" })).toBeEnabled());
  const csv = "External ID,Status\n" + Array.from({ length: 49 }, (_, index) => `ext-${index + 1},active`).join("\n");
  const file = new File([csv], "orders.csv");
  Object.defineProperties(file, {
    text: { value: async () => csv },
    arrayBuffer: { value: async () => new TextEncoder().encode(csv).buffer },
  });
  fireEvent.change(screen.getByLabelText("Upload CSV/XLSX"), { target: { files: [file] } });
  expect(await screen.findByText("ext-1")).toBeInTheDocument();
  expect(screen.queryByText("ext-21")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Build review" }));
  await waitFor(() => expect(mockUi.mappingStudio.preview).toHaveBeenCalledTimes(1));
  const source = mockUi.mappingStudio.preview.mock.calls[0]![0].source_payload;
  expect(source.columns).toEqual(["External ID", "Status"]);
  expect(source.sample_rows).toHaveLength(20);
  expect(source.sample_rows[19]).toEqual({ "External ID": "ext-20", Status: "active" });
});
