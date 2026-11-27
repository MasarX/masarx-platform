import * as React from "react";
import { createUiClient } from "@masarx/api";
import { createBrowserClient } from "@masarx/auth/browser";
import { formatUiError, UiMessageError } from "../utils";
import {
  openTrustedInNewTab,
  resolveTrustedExternalDataUrl,
} from "../url-guard";
import type { AssetItem, ScopeOption } from "./types";
import type { LabelDesignerAction, LabelDesignerState } from "./use-label-designer-store";
import {
  asText,
  formatJson,
  parseDraftRows,
  parseScopeKey,
  parseScopeOptions,
  parseShipmentBoxOptions,
  parseShipmentOptions,
  safeObject,
} from "./utils";

type Dispatch = React.Dispatch<LabelDesignerAction>;

type RpcResponse<T = unknown> = {
  ok?: boolean;
  value?: T;
  error?: { message?: unknown };
  [key: string]: unknown;
};

function useClients() {
  const ui = React.useMemo(() => createUiClient(), []);
  const supabase = React.useMemo(() => createBrowserClient(), []);

  const getUserJwt = React.useCallback(async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const jwt = asText(data.session?.access_token);
    if (!jwt) {
      throw new UiMessageError("Authentication session is missing. Please sign in again.");
    }
    return jwt;
  }, [supabase]);

  const invokeEdgeFunction = React.useCallback(
    async <T,>(name: string, body: Record<string, unknown>) => {
      const userJwt = await getUserJwt();
      const { data, error } = await supabase.functions.invoke(name, {
        body: { ...body, user_jwt: userJwt },
      });
      if (error) throw error;
      return data as T;
    },
    [getUserJwt, supabase],
  );

  return { ui, supabase, invokeEdgeFunction };
}

export function useBootstrap(
  dispatch: Dispatch,
  requestedScopeKey: string | null,
  requestedShipmentIdRef: React.MutableRefObject<string | null>,
) {
  const { ui } = useClients();

  const load = React.useCallback(async () => {
    dispatch({ type: "SET_BOOT_LOADING", payload: true });
    dispatch({ type: "SET_PAGE_ERROR", payload: null });

    try {
      const [who, meData, clients, senders, shipmentsResponse] = await Promise.all([
        ui.rpc<RpcResponse & {
          user_id?: unknown;
          organization_id?: unknown;
          can_read?: unknown;
          can_write?: unknown;
        }>("label_designer_whoami"),
        ui.me().catch(() => ({ capabilities: [] })),
        ui
          .listResource("clients", {}, 200, 0, { key: "created_at", direction: "desc" })
          .catch(() => ({ items: [] })),
        ui
          .listResource("senders", {}, 200, 0, { key: "created_at", direction: "desc" })
          .catch(() => ({ items: [] })),
        ui
          .listResource("shipments", {}, 100, 0, { key: "created_at", direction: "desc" })
          .catch(() => ({ items: [] })),
      ]);

      if (who?.ok !== true) {
        const message =
          asText(who?.error?.message) ||
          "Unable to resolve account context for label designer.";
        throw new Error(message);
      }

      const nextOrgId = asText(who.organization_id);
      if (!nextOrgId) {
        throw new UiMessageError("Organization context is required for label designer.");
      }

      const nextCapabilitiesSet = new Set<string>();
      if (Array.isArray(meData?.capabilities)) {
        for (const item of meData.capabilities) {
          if (typeof item !== "string") continue;
          const normalized = item.trim();
          if (!normalized) continue;
          nextCapabilitiesSet.add(normalized);
        }
      }
      if (who.can_read === true) {
        nextCapabilitiesSet.add("label_design.read");
      }
      if (who.can_write === true) {
        nextCapabilitiesSet.add("label_design.read");
        nextCapabilitiesSet.add("label_design.write");
      }

      const options = parseScopeOptions({
        organizationId: nextOrgId,
        clients: clients.items,
        senders: senders.items,
      });

      const requestedScope =
        requestedScopeKey && options.some((option) => option.key === requestedScopeKey)
          ? requestedScopeKey
          : null;

      const shipmentOptions = parseShipmentOptions(shipmentsResponse.items);

      const requestedShipmentId = requestedShipmentIdRef.current;
      let resolvedShipmentId: string;
      if (
        requestedShipmentId &&
        shipmentOptions.some((s) => s.id === requestedShipmentId)
      ) {
        resolvedShipmentId = requestedShipmentId;
        requestedShipmentIdRef.current = null;
      } else {
        resolvedShipmentId = shipmentOptions[0]?.id || "";
      }

      dispatch({
        type: "SET_BOOTSTRAP",
        payload: {
          organizationId: nextOrgId,
          capabilities: Array.from(nextCapabilitiesSet),
          scopeOptions: options,
          selectedScopeKey: requestedScope || options[0]?.key || "",
          shipments: shipmentOptions,
          selectedShipmentId: resolvedShipmentId,
        },
      });
    } catch (error) {
      dispatch({
        type: "SET_PAGE_ERROR",
        payload: formatUiError(error, "Could not initialize label designer."),
      });
      dispatch({ type: "SET_BOOT_LOADING", payload: false });
    }
  }, [dispatch, requestedScopeKey, requestedShipmentIdRef, ui]);

  return load;
}

export function useScopeData(
  state: LabelDesignerState,
  dispatch: Dispatch,
  selectedScope: ScopeOption | null,
  requestedDraftIdRef: React.MutableRefObject<string | null>,
) {
  const { ui } = useClients();
  const canRead = state.capabilities.includes("label_design.read");
  const requestSequence = React.useRef(0);
  React.useEffect(() => {
    requestSequence.current += 1;
    dispatch({ type: "CLEAR_LABEL_TYPE_OPTIONS" });
    return () => { requestSequence.current += 1; };
  }, [selectedScope?.scopeType, selectedScope?.scopeId, state.organizationId, canRead]);
  const selectionRef = React.useRef({ selectedDraftId: state.selectedDraftId, labelType: state.labelType });
  React.useEffect(() => {
    selectionRef.current = { selectedDraftId: state.selectedDraftId, labelType: state.labelType };
  }, [state.selectedDraftId, state.labelType]);

  const load = React.useCallback(
    async (preferredDraftId?: string | null) => {
      if (!selectedScope || !state.organizationId || !canRead) return;
      const requestId = ++requestSequence.current;

      dispatch({ type: "SET_SCOPE_LOADING", payload: true });
      dispatch({ type: "SET_PAGE_ERROR", payload: null });

      try {
        const [design, renderPolicy, printProfile, fieldCatalog, mediaCatalog, draftRows] =
          await Promise.all([
            ui.rpc<RpcResponse>("label_designer_get_effective_label_design", {
              p_scope_type: selectedScope.scopeType,
              p_scope_id: selectedScope.scopeId,
            }),
            ui.rpc<RpcResponse>("label_designer_get_effective_label_render_policy", {
              p_scope_type: selectedScope.scopeType,
              p_scope_id: selectedScope.scopeId,
            }),
            ui.rpc<RpcResponse>("label_designer_get_effective_label_print_profile", {
              p_scope_type: selectedScope.scopeType,
              p_scope_id: selectedScope.scopeId,
            }),
            ui.rpc<RpcResponse>("label_designer_get_field_catalog", {
              p_scope_type: selectedScope.scopeType,
              p_scope_id: selectedScope.scopeId,
            }),
            ui.rpc<RpcResponse>("label_designer_get_label_media_catalog", {
              p_scope_type: selectedScope.scopeType,
              p_scope_id: selectedScope.scopeId,
            }),
            ui.rpc<RpcResponse & { drafts?: unknown; label_types?: unknown }>("label_designer_list_drafts", {
              p_scope_type: selectedScope.scopeType,
              p_scope_id: selectedScope.scopeId,
            }),
          ]);

        if (requestId !== requestSequence.current) return;

        const responses = [
          ["label design", design],
          ["render policy", renderPolicy],
          ["print profile", printProfile],
          ["field catalog", fieldCatalog],
          ["media catalog", mediaCatalog],
          ["drafts", draftRows],
        ] as const;
        for (const [name, response] of responses) {
          if (response?.ok !== true) {
            const errorMessage =
              asText(response?.error?.message) ||
              `Could not load ${name} for selected scope.`;
            throw new Error(errorMessage);
          }
        }

        const parsedDrafts = parseDraftRows(draftRows.drafts);
        // Older servers may omit metadata; existing draft codes remain the fallback.
        const labelTypeOptions = Array.isArray(draftRows.label_types)
          ? draftRows.label_types.flatMap((entry: unknown) => {
              const row = safeObject(entry);
              return typeof row.value === "string" && row.value.trim() &&
                typeof row.label === "string" && row.label.trim()
                ? [{ value: row.value, label: row.label }]
                : [];
            })
          : [];

        const preferredId =
          preferredDraftId ||
          requestedDraftIdRef.current ||
          selectionRef.current.selectedDraftId ||
          parsedDrafts[0]?.id ||
          "";
        const resolvedDraft = parsedDrafts.find((draft) => draft.id === preferredId);

        let selectedDraftId: string;
        let draftName: string;
        let labelType: string;
        let draftEditor: string;

        if (resolvedDraft) {
          selectedDraftId = resolvedDraft.id;
          draftName = resolvedDraft.draft_name || "";
          labelType = resolvedDraft.label_type || "shipping";
          draftEditor = formatJson(resolvedDraft.draft_value);
          requestedDraftIdRef.current = null;
        } else {
          selectedDraftId = "";
          draftName = "";
          draftEditor = formatJson(safeObject(design.value));
          labelType = selectionRef.current.labelType || "shipping";
        }

        dispatch({
          type: "SET_SCOPE_DATA",
          payload: {
            effectiveDesignJson: formatJson(design.value),
            effectiveRenderPolicyJson: formatJson(renderPolicy.value),
            effectivePrintProfileJson: formatJson(printProfile.value),
            fieldCatalogJson: formatJson(fieldCatalog.value),
            mediaCatalogJson: formatJson(mediaCatalog.value),
            labelTypeOptions,
            drafts: parsedDrafts,
            selectedDraftId,
            draftName,
            labelType,
            draftEditor,
          },
        });
      } catch (error) {
        if (requestId !== requestSequence.current) return;
        dispatch({
          type: "SET_PAGE_ERROR",
          payload: formatUiError(error, "Could not load label designer data."),
        });
        dispatch({ type: "SET_SCOPE_LOADING", payload: false });
      }
    },
    [canRead, dispatch, requestedDraftIdRef, selectedScope, state.organizationId, ui],
  );

  return load;
}

export function useAssets(
  state: LabelDesignerState,
  dispatch: Dispatch,
) {
  const { invokeEdgeFunction } = useClients();
  const canRead = state.capabilities.includes("label_design.read");

  const load = React.useCallback(async () => {
    try {
      const response = await invokeEdgeFunction<{ ok?: boolean; assets?: unknown[] }>(
        "label-designer-assets",
        { mode: "list" },
      );
      if (response?.ok !== true) {
        throw new UiMessageError("Asset list request failed.");
      }
      const nextAssets = (Array.isArray(response.assets) ? response.assets : [])
        .map((asset) => {
          const record = safeObject(asset);
          const name = asText(record.name);
          const path = asText(record.path);
          if (!name || !path) return null;
          return { name, path };
        })
        .filter((asset): asset is AssetItem => Boolean(asset));
      nextAssets.sort((a, b) => a.name.localeCompare(b.name));
      dispatch({ type: "SET_ASSETS", payload: { assets: nextAssets, assetsError: null } });
    } catch (error) {
      dispatch({
        type: "SET_ASSETS",
        payload: { assets: [], assetsError: formatUiError(error, "Could not load assets.") },
      });
    }
  }, [dispatch, invokeEdgeFunction]);

  const upload = React.useCallback(
    async (file: File) => {
      const base64 = await readFileAsBase64Internal(file);
      if (!base64) throw new UiMessageError("Could not read selected file.");
      const response = await invokeEdgeFunction<{ ok?: boolean; error?: unknown }>(
        "label-designer-assets",
        {
          mode: "upload",
          file_name: file.name,
          content_type: file.type || "application/octet-stream",
          file_base64: base64,
        },
      );
      if (response?.ok !== true) {
        throw new Error(formatJson(response?.error || response));
      }
      await load();
    },
    [invokeEdgeFunction, load],
  );

  const openAsset = React.useCallback(
    async (path: string) => {
      const response = await invokeEdgeFunction<{
        ok?: boolean;
        signed_url?: unknown;
        error?: unknown;
      }>("label-designer-assets", {
        mode: "signed_url",
        path,
        expires_seconds: 300,
      });
      if (response?.ok !== true) {
        throw new Error(formatJson(response?.error || response));
      }
      const signedUrl = asText(response.signed_url);
      if (!signedUrl) throw new UiMessageError("Signed URL was not returned.");
      const trustedSignedUrl = resolveTrustedExternalDataUrl(signedUrl);
      if (!trustedSignedUrl) {
        throw new Error("Signed URL origin is not trusted.");
      }
      openTrustedInNewTab(trustedSignedUrl);
    },
    [invokeEdgeFunction],
  );

  const deleteAsset = React.useCallback(
    async (path: string) => {
      const response = await invokeEdgeFunction<{ ok?: boolean; error?: unknown }>(
        "label-designer-assets",
        { mode: "delete", path },
      );
      if (response?.ok !== true) {
        throw new Error(formatJson(response?.error || response));
      }
      await load();
    },
    [invokeEdgeFunction, load],
  );

  return { load, upload, openAsset, deleteAsset, canRead };
}

export function useShipmentBoxes(dispatch: Dispatch) {
  const { ui } = useClients();

  const load = React.useCallback(
    async (
      shipmentId: string,
      requestedShipmentBoxIdRef: React.MutableRefObject<string | null>,
    ) => {
      if (!shipmentId) {
        dispatch({
          type: "SET_SHIPMENT_BOXES",
          payload: { shipmentBoxes: [], selectedShipmentBoxId: "" },
        });
        return;
      }
      try {
        const response = await ui.listResource(
          "shipment_boxes",
          { shipment_id: shipmentId },
          200,
          0,
          { key: "box_number", direction: "asc" },
        );
        const options = parseShipmentBoxOptions(response.items);

        const requested = requestedShipmentBoxIdRef.current;
        let resolvedId: string;
        if (requested && options.some((option) => option.id === requested)) {
          resolvedId = requested;
          requestedShipmentBoxIdRef.current = null;
        } else {
          resolvedId = options[0]?.id || "";
        }

        dispatch({
          type: "SET_SHIPMENT_BOXES",
          payload: { shipmentBoxes: options, selectedShipmentBoxId: resolvedId },
        });
      } catch (error) {
        dispatch({
          type: "SET_SHIPMENT_BOXES",
          payload: { shipmentBoxes: [], selectedShipmentBoxId: "" },
        });
        dispatch({
          type: "SET_PAGE_ERROR",
          payload: formatUiError(error, "Could not load shipment boxes."),
        });
      }
    },
    [dispatch, ui],
  );

  return load;
}

export function usePreview(
  state: LabelDesignerState,
  dispatch: Dispatch,
) {
  const { ui, invokeEdgeFunction } = useClients();

  const loadSamplePayload = React.useCallback(async () => {
    if (!state.selectedShipmentId) {
      throw new UiMessageError("Select a shipment first.");
    }
    const response = await ui.rpc<{ ok?: boolean; payload?: unknown; error?: unknown }>(
      "label_designer_get_sample_payload",
      {
        p_shipment_id: state.selectedShipmentId,
        p_shipment_box_id: state.selectedShipmentBoxId || null,
      },
    );
    if (response?.ok !== true) {
      throw new Error(formatJson(response?.error || response));
    }
    dispatch({ type: "SET_SAMPLE_PAYLOAD", payload: formatJson(response.payload) });
  }, [dispatch, state.selectedShipmentBoxId, state.selectedShipmentId, ui]);

  const previewDraft = React.useCallback(async () => {
    if (!state.selectedDraftId) throw new UiMessageError("Select a draft before preview.");
    if (!state.selectedShipmentId) throw new UiMessageError("Select a shipment before preview.");

    const response = await invokeEdgeFunction<{ ok?: boolean; error?: unknown }>(
      "label-renderer",
      {
        mode: "designer_preview",
        draft_id: state.selectedDraftId,
        label_type: asText(state.labelType) || "shipping",
        shipment_id: state.selectedShipmentId,
        shipment_box_id: state.selectedShipmentBoxId || null,
      },
    );
    if (response?.ok !== true) {
      throw new Error(formatJson(response?.error || response));
    }
    dispatch({ type: "SET_PREVIEW_RESPONSE", payload: formatJson(response) });
  }, [dispatch, invokeEdgeFunction, state.labelType, state.selectedDraftId, state.selectedShipmentBoxId, state.selectedShipmentId]);

  return { loadSamplePayload, previewDraft };
}

export function useDraftActions(
  state: LabelDesignerState,
  dispatch: Dispatch,
  selectedScope: ScopeOption | null,
  loadScopeData: (preferredDraftId?: string | null) => Promise<void>,
) {
  const { ui } = useClients();

  const parseDraftEditorValue = React.useCallback(() => {
    try {
      const parsed = JSON.parse(state.draftEditor);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new UiMessageError("Draft JSON must be an object.");
      }
      dispatch({ type: "SET_DRAFT_EDITOR_ERROR", payload: null });
      return parsed as Record<string, unknown>;
    } catch (error) {
      const message = formatUiError(error, "Draft JSON is invalid.");
      dispatch({ type: "SET_DRAFT_EDITOR_ERROR", payload: message });
      return null;
    }
  }, [dispatch, state.draftEditor]);

  const assertWriteScope = React.useCallback(() => {
    if (!state.capabilities.includes("label_design.write")) throw new UiMessageError("Write permission is required.");
    if (!selectedScope || !state.organizationId) throw new UiMessageError("Scope context is missing.");
  }, [selectedScope, state.capabilities, state.organizationId]);

  const createDraft = React.useCallback(async () => {
    assertWriteScope();
    if (!selectedScope || !state.organizationId) {
      throw new UiMessageError("Scope context is missing.");
    }
    const parsed = parseDraftEditorValue();
    if (!parsed) throw new UiMessageError("Draft JSON is invalid.");
    const nextLabelType = asText(state.labelType) || "shipping";
    const nextName = asText(state.draftName) || `Draft ${new Date().toISOString()}`;

    const response = await ui.rpc<RpcResponse & { draft?: unknown }>(
      "label_designer_create_draft",
      {
        p_scope_type: selectedScope.scopeType,
        p_scope_id: selectedScope.scopeId,
        p_label_type: nextLabelType,
        p_draft_name: nextName,
        p_draft_value: parsed,
      },
    );
    if (response?.ok !== true) {
      const message = asText(response?.error?.message) || "Draft create request failed.";
      throw new Error(message);
    }
    const insertedDraft = parseDraftRows([response.draft])[0];
    if (!insertedDraft) throw new UiMessageError("Draft was created but could not be parsed.");
    if (insertedDraft.id === state.selectedDraftId || !isDraftStatusInternal(insertedDraft.status) ||
        insertedDraft.scope_type !== selectedScope.scopeType || insertedDraft.scope_id !== selectedScope.scopeId ||
        insertedDraft.label_type !== nextLabelType) {
      throw new Error("Created draft does not match the requested new draft and scope.");
    }
    await loadScopeData(insertedDraft.id);
  }, [assertWriteScope, loadScopeData, parseDraftEditorValue, selectedScope, state.draftName, state.labelType, state.organizationId, state.selectedDraftId, ui]);

  const saveDraft = React.useCallback(async () => {
    assertWriteScope();
    const selectedDraft = state.drafts.find((d) => d.id === state.selectedDraftId);
    if (!selectedDraft) throw new UiMessageError("Select a draft before saving.");
    if (selectedDraft.scope_type !== selectedScope?.scopeType || selectedDraft.scope_id !== selectedScope?.scopeId) {
      throw new UiMessageError("Selected draft does not match the active scope.");
    }
    if (!isDraftStatusInternal(selectedDraft.status)) {
      throw new UiMessageError("Published drafts are immutable. Create a new draft first.");
    }
    const parsed = parseDraftEditorValue();
    if (!parsed) throw new UiMessageError("Draft JSON is invalid.");

    const response = await ui.rpc<RpcResponse & { draft?: unknown }>(
      "label_designer_update_draft",
      {
        p_draft_id: selectedDraft.id,
        p_draft_name: asText(state.draftName) || null,
        p_label_type: asText(state.labelType) || "shipping",
        p_draft_value: parsed,
      },
    );
    if (response?.ok !== true) {
      const message = asText(response?.error?.message) || "Draft update request failed.";
      throw new Error(message);
    }
    await loadScopeData(selectedDraft.id);
  }, [assertWriteScope, loadScopeData, parseDraftEditorValue, selectedScope, state.draftName, state.drafts, state.labelType, state.selectedDraftId, ui]);

  const validateDraft = React.useCallback(async () => {
    if (!state.selectedDraftId) throw new UiMessageError("Select a draft before validating.");
    const response = await ui.rpc<{ ok?: boolean; errors?: unknown }>(
      "label_designer_validate_label_design_draft",
      { p_draft_id: state.selectedDraftId },
    );
    if (response?.ok !== true) {
      const errors = formatJson(response?.errors ?? response);
      throw new Error(`Validation failed: ${errors}`);
    }
    dispatch({ type: "SET_PREVIEW_RESPONSE", payload: formatJson(response) });
  }, [dispatch, state.selectedDraftId, ui]);

  const publishDraft = React.useCallback(async () => {
    if (!state.selectedDraftId) throw new UiMessageError("Select a draft before publishing.");
    // Publish the editor's current value, never a stale saved row or a published original.
    await saveDraft();
    await validateDraft();
    const response = await ui.rpc<RpcResponse>(
      "label_designer_publish_label_design_draft",
      {
        p_draft_id: state.selectedDraftId,
        p_change_reason: asText(state.draftName)
          ? `Publish ${asText(state.draftName)}`
          : "Publish label design draft",
      },
    );
    if (response?.ok !== true) {
      const message =
        asText(response?.error?.message) ||
        "Publish request failed. Check draft validation errors.";
      throw new Error(message);
    }
    await loadScopeData(state.selectedDraftId);
  }, [loadScopeData, saveDraft, state.draftName, state.selectedDraftId, ui, validateDraft]);

  return { createDraft, saveDraft, validateDraft, publishDraft, parseDraftEditorValue };
}

function readFileAsBase64Internal(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new UiMessageError("Could not read file."));
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const marker = raw.indexOf(",");
      resolve(marker >= 0 ? raw.slice(marker + 1) : raw);
    };
    reader.readAsDataURL(file);
  });
}

function isDraftStatusInternal(status: string) {
  return status.trim().toLowerCase() === "draft";
}

export function useRunWithBusyState(dispatch: Dispatch) {
  return React.useCallback(
    async (name: string, runner: () => Promise<void>) => {
      dispatch({ type: "SET_BUSY", payload: name });
      dispatch({ type: "SET_PAGE_ERROR", payload: null });
      try {
        await runner();
      } catch (error) {
        dispatch({
          type: "SET_PAGE_ERROR",
          payload: formatUiError(error, "Action failed."),
        });
      } finally {
        dispatch({ type: "SET_BUSY", payload: null });
      }
    },
    [dispatch],
  );
}

export { parseScopeKey };
