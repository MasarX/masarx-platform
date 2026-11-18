import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LabelDesignerPage } from "../../packages/ui/src/label-designer-page";

const mockRpc = jest.fn();
const mockUi = {
  rpc: mockRpc,
  me: async () => ({ capabilities: ["label_design.read", "label_design.write"] }),
  listResource: async (resource: string) => ({ items: resource === "clients" ? [{ id: "client", name: "Client" }] : [] }),
};
jest.mock("@masarx/api", () => ({
  ...jest.requireActual("../../packages/api/src/capabilities"),
  createUiClient: () => mockUi,
}));
jest.mock("@masarx/auth/browser", () => ({ createBrowserClient: () => ({
  auth: { getSession: async () => ({ data: { session: { access_token: "test-jwt" } } }) },
  functions: { invoke: async () => ({ data: { ok: true, assets: [] } }) },
}) }));
jest.mock("../../packages/ui/src/label-designer/preview-panel", () => ({ PreviewPanel: () => null }));
jest.mock("../../packages/ui/src/label-designer/asset-manager", () => ({ AssetManager: () => null }));
jest.mock("../../packages/ui/src/label-designer/effective-config-panel", () => ({ EffectiveConfigPanel: () => null }));

const design = { templates: {
  shipping: { blocks: [{ type: "text", x: 10, y: 10, fallback: "shipping" }] },
  return: { blocks: [{ type: "text", x: 20, y: 20, fallback: "return" }] },
} };
const drafts = ["shipping", "return"].map((label_type) => ({
  id: label_type, scope_type: "tenant", scope_id: "org", label_type, draft_name: label_type,
  status: "draft", draft_value: design,
}));
const scopeCalls = () => mockRpc.mock.calls.filter(([name]) => name !== "label_designer_whoami");

beforeEach(() => {
  mockRpc.mockReset().mockImplementation(async (name) => {
    if (name === "label_designer_whoami") return { ok: true, organization_id: "org", can_read: true, can_write: true };
    if (name === "label_designer_list_drafts") return { ok: true, drafts };
    return { ok: true, value: name === "label_designer_get_effective_label_design" ? design : {} };
  });
});

test("page effect loads a scope once; local type, selection and editor changes do not refetch or erase edits", async () => {
  render(<LabelDesignerPage appBasePath="/console" testIdPrefix="ld" />);
  await waitFor(() => expect(screen.getByTestId("ld-draft-select")).toHaveValue("shipping"));
  expect(scopeCalls()).toHaveLength(6);
  fireEvent.click(screen.getByTestId("ld-tab-code"));
  const unsaved = JSON.stringify({ ...design, unsaved: "keep this" });
  fireEvent.change(screen.getByTestId("ld-draft-json"), { target: { value: unsaved } });
  fireEvent.change(screen.getByTestId("ld-draft-name"), { target: { value: "Unsaved name" } });
  fireEvent.change(screen.getByTestId("ld-label-type"), { target: { value: "return" } });
  await act(async () => {});
  expect(scopeCalls()).toHaveLength(6);
  expect(screen.getByTestId("ld-label-type")).toHaveValue("return");
  expect(screen.getByTestId("ld-draft-json")).toHaveValue(unsaved);
  expect(screen.getByTestId("ld-draft-name")).toHaveValue("Unsaved name");

  fireEvent.change(screen.getByTestId("ld-draft-select"), { target: { value: "return" } });
  await act(async () => {});
  expect(scopeCalls()).toHaveLength(6);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(scopeCalls()).toHaveLength(12));
  expect(screen.getByTestId("ld-draft-select")).toHaveValue("return");
  expect(screen.getByTestId("ld-label-type")).toHaveValue("return");

  fireEvent.change(screen.getByTestId("ld-scope-select"), { target: { value: "client:client" } });
  await waitFor(() => expect(scopeCalls()).toHaveLength(18));
  expect(scopeCalls().slice(-6).every(([, args]) => args.p_scope_type === "client" && args.p_scope_id === "client")).toBe(true);
});
