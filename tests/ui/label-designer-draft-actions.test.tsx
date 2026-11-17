import { act, renderHook } from "@testing-library/react";
import { useDraftActions } from "../../packages/ui/src/label-designer/use-label-designer-data";
import { initialState } from "../../packages/ui/src/label-designer/use-label-designer-store";
import type { LabelDesignerState } from "../../packages/ui/src/label-designer/use-label-designer-store";

const mockRpc = jest.fn();
jest.mock("@masarx/api", () => ({ createUiClient: () => ({ rpc: mockRpc }) }));
jest.mock("@masarx/auth/browser", () => ({ createBrowserClient: () => ({}) }));

const scope = { key: "tenant:org", scopeType: "tenant" as const, scopeId: "org", label: "Tenant" };
const published = { id: "published", scope_type: "tenant" as const, scope_id: "org", label_type: "shipping", draft_name: "Original", draft_value: { blocks: [] }, status: "published", updated_at: null, published_at: "2026-01-01" };
const created = { ...published, id: "new-draft", status: "draft", published_at: null };
const state: LabelDesignerState = { ...initialState, organizationId: "org", capabilities: ["label_design.read", "label_design.write"], selectedScopeKey: scope.key, drafts: [published], selectedDraftId: published.id, draftName: "Next design", draftEditor: '{"blocks":[{"type":"text","x":10,"y":10,"fallback":"New"}]}' };

beforeEach(() => mockRpc.mockReset());

test("forks into a NEW draft, saves/validates/publishes only the new ID, leaving the original immutable", async () => {
  const original = JSON.stringify(published);
  const dispatch = jest.fn(), load = jest.fn().mockResolvedValue(undefined);
  mockRpc.mockResolvedValueOnce({ ok: true, draft: created });
  const { result, rerender } = renderHook(({ value }) => useDraftActions(value, dispatch, scope, load), { initialProps: { value: state } });
  await act(async () => { await result.current.createDraft(); });
  expect(mockRpc).toHaveBeenCalledWith("label_designer_create_draft", expect.objectContaining({ p_draft_value: JSON.parse(state.draftEditor), p_scope_id: "org" }));
  expect(load).toHaveBeenCalledWith(created.id);
  expect(mockRpc).not.toHaveBeenCalledWith("label_designer_update_draft", expect.anything());
  rerender({ value: { ...state, drafts: [created, published], selectedDraftId: created.id } });
  mockRpc.mockResolvedValue({ ok: true });
  await act(async () => { await result.current.publishDraft(); });
  expect(mockRpc.mock.calls.slice(1).map(([name]) => name)).toEqual([
    "label_designer_update_draft", "label_designer_validate_label_design_draft", "label_designer_publish_label_design_draft",
  ]);
  mockRpc.mock.calls.slice(1).forEach(([, args]) => expect(args.p_draft_id).toBe(created.id));
  expect(JSON.stringify(published)).toBe(original);
});

test.each(["{bad", "[]", "null"])("invalid JSON %s cannot create/fork or publish a stale saved value", async (draftEditor) => {
  const dispatch = jest.fn(), load = jest.fn();
  const { result } = renderHook(() => useDraftActions({ ...state, drafts: [created], selectedDraftId: created.id, draftEditor }, dispatch, scope, load));
  await expect(result.current.createDraft()).rejects.toThrow("JSON is invalid");
  await expect(result.current.publishDraft()).rejects.toThrow("JSON is invalid");
  expect(mockRpc).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "SET_DRAFT_EDITOR_ERROR" }));
});

test("published save/publish is still rejected; no update or publish RPC is issued", async () => {
  const { result } = renderHook(() => useDraftActions(state, jest.fn(), scope, jest.fn()));
  await expect(result.current.saveDraft()).rejects.toThrow("Published drafts are immutable");
  await expect(result.current.publishDraft()).rejects.toThrow("Published drafts are immutable");
  expect(mockRpc).not.toHaveBeenCalled();
});

test.each([
  ["permission", { ...state, capabilities: [] }, scope],
  ["scope", state, null],
  ["mismatched scope", { ...state, drafts: [{ ...created, scope_id: "other" }], selectedDraftId: created.id }, scope],
])("%s failure cannot write or publish", async (_name, value, selectedScope) => {
  const { result } = renderHook(() => useDraftActions(value, jest.fn(), selectedScope, jest.fn()));
  await expect(result.current.publishDraft()).rejects.toThrow();
  expect(mockRpc).not.toHaveBeenCalled();
});

test.each([
  { ok: false, error: { message: "create denied" } },
  { ok: true, draft: published },
  { ok: true, draft: { ...created, scope_id: "other" } },
  { ok: true, draft: { ...created, id: "published" } },
])("create failure or invalid readback never selects/publishes an old row (case %#)", async (response) => {
  mockRpc.mockResolvedValue(response);
  const load = jest.fn();
  const { result } = renderHook(() => useDraftActions(state, jest.fn(), scope, load));
  await expect(result.current.createDraft()).rejects.toThrow();
  expect(load).not.toHaveBeenCalled();
  expect(mockRpc).toHaveBeenCalledTimes(1);
});

test("failed validation stops publish after saving the current editor", async () => {
  mockRpc.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, errors: ["invalid template"] });
  const { result } = renderHook(() => useDraftActions({ ...state, drafts: [created], selectedDraftId: created.id }, jest.fn(), scope, jest.fn()));
  await expect(result.current.publishDraft()).rejects.toThrow("Validation failed");
  expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(["label_designer_update_draft", "label_designer_validate_label_design_draft"]);
});
