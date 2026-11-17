import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { useScopeData } from "../../packages/ui/src/label-designer/use-label-designer-data";
import { initialState, labelDesignerReducer } from "../../packages/ui/src/label-designer/use-label-designer-store";
const mockRpc = jest.fn();
const mockUi = { rpc: mockRpc };
jest.mock("@masarx/api", () => ({ createUiClient: () => mockUi }));
jest.mock("@masarx/auth/browser", () => ({ createBrowserClient: () => ({}) }));
jest.mock("@masarx/config", () => ({ getPublicConfig: () => ({}) }));
const metadata = [{ value: "shipping", label: "Shipment document" }];
function useHarness(scopeId: string, canRead = true) {
  const [state, dispatch] = React.useReducer(labelDesignerReducer,
    { ...initialState, organizationId: "org-a", capabilities: ["label_design.read"] });
  const requested = React.useRef<string | null>(null);
  const scope = React.useMemo(() => ({ key: scopeId, label: scopeId,
    scopeType: "tenant" as const, scopeId }), [scopeId]);
  const load = useScopeData({ ...state, capabilities: canRead ? ["label_design.read"] : [] }, dispatch, scope, requested);
  return { state, load };
}
describe("label metadata scoped RPC propagation", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockImplementation(async (name: string) => name === "label_designer_list_drafts"
      ? { ok: true, drafts: [], label_types: metadata } : { ok: true, value: {} });
  });
  test("actual scope hook carries registry labels into reducer state", async () => {
    const { result } = renderHook(() => useHarness("org-a"));
    await act(async () => { await result.current.load(); });
    expect(mockRpc).toHaveBeenCalledWith("label_designer_list_drafts",
      { p_scope_type: "tenant", p_scope_id: "org-a" });
    expect(result.current.state.labelTypeOptions).toEqual(metadata);
  });
  test("an old scope response cannot install metadata after switching scopes", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(res => { resolve = res; });
    mockRpc.mockImplementation(async (name: string) => name === "label_designer_list_drafts"
      ? pending : { ok: true, value: {} });
    const { result, rerender } = renderHook(({ id }) => useHarness(id),
      { initialProps: { id: "org-a" } });
    let work!: Promise<void>;
    act(() => { work = result.current.load(); });
    rerender({ id: "org-b" });
    await act(async () => {
      resolve({ ok: true, drafts: [], label_types: metadata });
      await work;
    });
    expect(result.current.state.labelTypeOptions).toEqual([]);
  });
  test("older-server metadata absence preserves explicit code fallback", async () => {
    mockRpc.mockResolvedValue({ ok: true, value: {}, drafts: [] });
    const { result } = renderHook(() => useHarness("org-a"));
    await act(async () => { await result.current.load(); });
    expect(result.current.state.labelTypeOptions).toEqual([]);
  });
  test("permission revocation clears previously loaded metadata without another read", async () => {
    const { result, rerender } = renderHook(({ allowed }) => useHarness("org-a", allowed),
      { initialProps: { allowed: true } });
    await act(async () => { await result.current.load(); });
    expect(result.current.state.labelTypeOptions).toEqual(metadata);
    rerender({ allowed: false });
    expect(result.current.state.labelTypeOptions).toEqual([]);
  });
  test("bootstrap replacement clears prior organization catalog metadata", () => {
    const next = labelDesignerReducer({ ...initialState, labelTypeOptions: metadata }, {
      type: "SET_BOOTSTRAP", payload: { organizationId: "org-b", capabilities: [],
        scopeOptions: [], selectedScopeKey: "", shipments: [], selectedShipmentId: "" },
    });
    expect(next.labelTypeOptions).toEqual([]);
  });

});
