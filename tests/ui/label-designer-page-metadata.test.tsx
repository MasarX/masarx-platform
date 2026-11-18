import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { LabelDesignerPage } from "../../packages/ui/src/label-designer-page";
import { initialState } from "../../packages/ui/src/label-designer/use-label-designer-store";
const mockDispatch = jest.fn();
const mockNoop = jest.fn();
let mockState: typeof initialState;
jest.mock("../../packages/ui/src/label-designer/use-label-designer-store", () => ({
  ...jest.requireActual("../../packages/ui/src/label-designer/use-label-designer-store"),
  useLabelDesignerStore: () => [mockState, mockDispatch],
}));
jest.mock("../../packages/ui/src/label-designer/use-label-designer-data", () => ({
  useBootstrap: () => mockNoop, useScopeData: () => mockNoop,
  useAssets: () => ({ load: mockNoop, upload: mockNoop, openAsset: mockNoop, deleteAsset: mockNoop }),
  useShipmentBoxes: () => mockNoop,
  usePreview: () => ({ loadSamplePayload: mockNoop, previewDraft: mockNoop }),
  useDraftActions: () => ({ createDraft: mockNoop, saveDraft: mockNoop, validateDraft: mockNoop, publishDraft: mockNoop }),
  useRunWithBusyState: () => mockNoop,
}));
jest.mock("../../packages/ui/src/label-designer/scope-selector", () => ({ ScopeSelector: () => null }));
jest.mock("../../packages/ui/src/label-designer/preview-panel", () => ({ PreviewPanel: () => null }));
jest.mock("../../packages/ui/src/label-designer/asset-manager", () => ({ AssetManager: () => null }));
jest.mock("../../packages/ui/src/label-designer/effective-config-panel", () => ({ EffectiveConfigPanel: () => null }));
test("actual page passes ordered registry labels and unknown-code fallback to the real selector", () => {
  mockState = { ...initialState, bootLoading: false, organizationId: "org",
    capabilities: ["label_design.read", "label_design.write"],
    labelType: "old_code",
    effectiveDesignJson: JSON.stringify({ templates: { extra_code: {} } }),
    labelTypeOptions: [{ value: "return", label: "Return document" }, { value: "shipping", label: "Shipment document" }] };
  render(<LabelDesignerPage appBasePath="/console" testIdPrefix="ld" />);
  const select = screen.getByTestId("ld-label-type");
  expect(within(select).getAllByRole("option").map(option => [option.getAttribute("value"), option.textContent]))
    .toEqual([["return","Return document"],["shipping","Shipment document"],["extra_code","extra_code"],["old_code","old_code"]]);
  fireEvent.change(select, { target: { value: "return" } });
  expect(mockDispatch).toHaveBeenCalledWith({ type: "SET_LABEL_TYPE", payload: "return" });
});
