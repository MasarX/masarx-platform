"use client";

import * as React from "react";
import Link from "next/link";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { Badge } from "./badge";
import { Button } from "./button";
import { ContextNotice } from "./context-notice";
import { createUiTranslator } from "./i18n";
import { LoadingState } from "./loading-state";
import { PageHeader } from "./page-header";

const t = createUiTranslator("ui.labelDesigner.page");
import type { LabelDesignerPageProps } from "./label-designer/types";
import { asText, firstParam, formatJson, parseScopeKey, parseJsonObject, safeObject } from "./label-designer/utils";
import { useLabelDesignerStore } from "./label-designer/use-label-designer-store";
import {
  useBootstrap,
  useScopeData,
  useAssets,
  useShipmentBoxes,
  usePreview,
  useDraftActions,
  useRunWithBusyState,
} from "./label-designer/use-label-designer-data";
import { ScopeSelector } from "./label-designer/scope-selector";
import { DraftWorkflow } from "./label-designer/draft-workflow";
import { PreviewPanel } from "./label-designer/preview-panel";
import { AssetManager } from "./label-designer/asset-manager";
import { EffectiveConfigPanel } from "./label-designer/effective-config-panel";

export type { LabelDesignerPageProps };

/**
 * Browser label designer page. Uses existing API-schema RPC wrappers + edge
 * functions (preview/assets) and keeps scope behavior row-driven.
 */
export function LabelDesignerPage({
  appBasePath,
  searchParams,
  testIdPrefix,
}: LabelDesignerPageProps) {
  const [state, dispatch] = useLabelDesignerStore();

  const prefix = (testIdPrefix || "label-designer").trim() || "label-designer";

  const requestedScopeKey = React.useMemo(() => {
    const scopeType = asText(firstParam(searchParams?.scope_type)).toLowerCase();
    const scopeId = asText(firstParam(searchParams?.scope_id));
    if (!scopeType || !scopeId) return null;
    return parseScopeKey(`${scopeType}:${scopeId}`);
  }, [searchParams]);

  const requestedDraftIdRef = React.useRef(
    asText(firstParam(searchParams?.draft_id)) || null,
  );
  const requestedShipmentIdRef = React.useRef(
    asText(firstParam(searchParams?.shipment_id)) || null,
  );
  const requestedShipmentBoxIdRef = React.useRef(
    asText(firstParam(searchParams?.shipment_box_id)) || null,
  );

  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(state.capabilities),
    [state.capabilities],
  );
  const canRead = hasCapability(capabilitySet, "label_design.read");
  const canWrite = hasCapability(capabilitySet, "label_design.write");
  const isBusy = Boolean(state.busyAction);

  const selectedScope = React.useMemo(() => {
    if (state.scopeOptions.length === 0) return null;
    return (
      state.scopeOptions.find((o) => o.key === state.selectedScopeKey) ||
      state.scopeOptions[0] ||
      null
    );
  }, [state.scopeOptions, state.selectedScopeKey]);

  const labelTypeOptions = React.useMemo(() => {
    const set = new Set<string>();
    if (state.labelType) set.add(state.labelType);
    for (const draft of state.drafts) {
      if (draft.label_type) set.add(draft.label_type);
    }
    const parsed = parseJsonObject(state.effectiveDesignJson || "{}");
    const templates = safeObject(parsed.templates);
    for (const key of Object.keys(templates)) {
      if (key.trim()) set.add(key.trim());
    }
    if (set.size === 0) set.add("shipping");
    // Keep canonical registry ordering and labels; preserve unknown existing codes.
    const options = new Map(state.labelTypeOptions.map((option) => [option.value, option]));
    for (const value of Array.from(set).sort((a, b) => a.localeCompare(b))) {
      if (!options.has(value)) options.set(value, { value, label: value });
    }
    return Array.from(options.values());
  }, [state.drafts, state.effectiveDesignJson, state.labelType, state.labelTypeOptions]);

  // --- Data hooks ---

  const loadBootstrap = useBootstrap(dispatch, requestedScopeKey, requestedShipmentIdRef);
  const loadScopeData = useScopeData(state, dispatch, selectedScope, requestedDraftIdRef);
  const { load: loadAssets, upload: uploadAsset, openAsset, deleteAsset } = useAssets(state, dispatch);
  const loadShipmentBoxes = useShipmentBoxes(dispatch);
  const { loadSamplePayload, previewDraft } = usePreview(state, dispatch);
  const { createDraft, saveDraft, validateDraft, publishDraft } = useDraftActions(
    state,
    dispatch,
    selectedScope,
    loadScopeData,
  );
  const runWithBusyState = useRunWithBusyState(dispatch);

  // --- Effects ---

  React.useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  React.useEffect(() => {
    if (!selectedScope || !state.organizationId || !canRead) return;
    void loadScopeData();
  }, [canRead, loadScopeData, state.organizationId, selectedScope]);

  React.useEffect(() => {
    if (!state.selectedShipmentId) {
      dispatch({
        type: "SET_SHIPMENT_BOXES",
        payload: { shipmentBoxes: [], selectedShipmentBoxId: "" },
      });
      return;
    }
    void loadShipmentBoxes(state.selectedShipmentId, requestedShipmentBoxIdRef);
  }, [dispatch, loadShipmentBoxes, state.selectedShipmentId]);

  React.useEffect(() => {
    if (!canRead || !state.organizationId) return;
    void loadAssets();
  }, [canRead, loadAssets, state.organizationId]);

  // --- Keyboard shortcuts (Mod+S: save, Mod+P: preview) ---

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "s") {
        e.preventDefault();
        if (canWrite && !isBusy && state.selectedDraftId) {
          void runWithBusyState("save-draft", saveDraft);
        }
      }
      if (e.key === "p") {
        e.preventDefault();
        if (!isBusy && state.selectedDraftId && state.selectedShipmentId) {
          void runWithBusyState("preview-draft", previewDraft);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canWrite, isBusy, previewDraft, runWithBusyState, saveDraft, state.selectedDraftId, state.selectedShipmentId]);

  // --- Handlers ---

  const handleDraftSelection = React.useCallback(
    (draftId: string) => {
      const draft = state.drafts.find((d) => d.id === draftId);
      if (!draft) return;
      dispatch({
        type: "SELECT_DRAFT",
        payload: {
          selectedDraftId: draftId,
          draftName: draft.draft_name || "",
          labelType: draft.label_type || "shipping",
          draftEditor: formatJson(draft.draft_value),
        },
      });
    },
    [dispatch, state.drafts],
  );

  const handleCreateDraft = React.useCallback(() => {
    void runWithBusyState("create-draft", createDraft);
  }, [createDraft, runWithBusyState]);

  const handleSaveDraft = React.useCallback(() => {
    void runWithBusyState("save-draft", saveDraft);
  }, [runWithBusyState, saveDraft]);

  const handleValidateDraft = React.useCallback(() => {
    void runWithBusyState("validate-draft", validateDraft);
  }, [runWithBusyState, validateDraft]);

  const handlePublishDraft = React.useCallback(() => {
    void runWithBusyState("publish-draft", publishDraft);
  }, [publishDraft, runWithBusyState]);

  const handleLoadSamplePayload = React.useCallback(() => {
    void runWithBusyState("sample-payload", loadSamplePayload);
  }, [loadSamplePayload, runWithBusyState]);

  const handlePreviewDraft = React.useCallback(() => {
    void runWithBusyState("preview-draft", previewDraft);
  }, [previewDraft, runWithBusyState]);

  const handleUploadAsset = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] || null;
      event.currentTarget.value = "";
      if (!file) return;
      void runWithBusyState("upload-asset", () => uploadAsset(file));
    },
    [runWithBusyState, uploadAsset],
  );

  const handleOpenAsset = React.useCallback(
    (path: string) => {
      void runWithBusyState("asset-url", () => openAsset(path));
    },
    [openAsset, runWithBusyState],
  );

  const handleDeleteAsset = React.useCallback(
    (path: string) => {
      void runWithBusyState("delete-asset", () => deleteAsset(path));
    },
    [deleteAsset, runWithBusyState],
  );

  // --- Render ---

  if (state.bootLoading) {
    return <LoadingState variant="page" testId={`${prefix}-loading`} />;
  }

  if (!canRead) {
    return (
      <div className="space-y-6" data-testid={`${prefix}-denied`}>
        <PageHeader
          title={t("title")}
          description={t("deniedTitle")}
          actions={
            <Button asChild size="sm" variant="ghost">
              <Link href={`${appBasePath}/access-policy`}>{t("openAccessPolicy")}</Link>
            </Button>
          }
        />
        <ContextNotice
          title={t("deniedMessage")}
          action={t("deniedAction")}
          detail={t("deniedDetail")}
          testId={`${prefix}-capability-error`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid={`${prefix}-ready`}>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={canWrite ? "success" : "warning"}>
              {canWrite ? t("writeEnabled") : t("readOnly")}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={isBusy || state.scopeLoading}
              onClick={() => {
                void loadScopeData(state.selectedDraftId || null);
                void loadAssets();
              }}
            >
              {t("refresh")}
            </Button>
          </div>
        }
      />

      {state.pageError ? (
        <ContextNotice
          title={t("actionFailed")}
          action={t("actionFailedAction")}
          detail={state.pageError}
          testId={`${prefix}-error`}
        />
      ) : null}

      <ScopeSelector
        prefix={prefix}
        scopeOptions={state.scopeOptions}
        selectedScopeKey={selectedScope?.key || ""}
        organizationId={state.organizationId}
        scopeLoading={state.scopeLoading}
        onScopeChange={(key) => dispatch({ type: "SET_SELECTED_SCOPE_KEY", payload: key })}
      />

      <DraftWorkflow
        prefix={prefix}
        canWrite={canWrite}
        isBusy={isBusy}
        busyAction={state.busyAction}
        selectedScope={selectedScope}
        drafts={state.drafts}
        selectedDraftId={state.selectedDraftId}
        draftName={state.draftName}
        labelType={state.labelType}
        labelTypeOptions={labelTypeOptions}
        draftEditor={state.draftEditor}
        draftEditorError={state.draftEditorError}
        fieldCatalogJson={state.fieldCatalogJson}
        assets={state.assets}
        onDraftSelection={handleDraftSelection}
        onDraftNameChange={(v) => dispatch({ type: "SET_DRAFT_NAME", payload: v })}
        onLabelTypeChange={(v) => dispatch({ type: "SET_LABEL_TYPE", payload: v })}
        onDraftEditorChange={(v) => dispatch({ type: "SET_DRAFT_EDITOR", payload: v })}
        onCreateDraft={handleCreateDraft}
        onSaveDraft={handleSaveDraft}
        onValidateDraft={handleValidateDraft}
        onPublishDraft={handlePublishDraft}
      />

      <PreviewPanel
        prefix={prefix}
        isBusy={isBusy}
        busyAction={state.busyAction}
        shipments={state.shipments}
        selectedShipmentId={state.selectedShipmentId}
        shipmentBoxes={state.shipmentBoxes}
        selectedShipmentBoxId={state.selectedShipmentBoxId}
        selectedDraftId={state.selectedDraftId}
        samplePayloadJson={state.samplePayloadJson}
        previewResponseJson={state.previewResponseJson}
        onShipmentChange={(id) => dispatch({ type: "SET_SELECTED_SHIPMENT_ID", payload: id })}
        onShipmentBoxChange={(id) => dispatch({ type: "SET_SELECTED_SHIPMENT_BOX_ID", payload: id })}
        onLoadSamplePayload={handleLoadSamplePayload}
        onPreviewDraft={handlePreviewDraft}
      />

      <AssetManager
        prefix={prefix}
        isBusy={isBusy}
        canWrite={canWrite}
        assets={state.assets}
        assetsError={state.assetsError}
        onUpload={handleUploadAsset}
        onUploadFiles={(files) => {
          for (const file of files) {
            void runWithBusyState("upload-asset", () => uploadAsset(file));
          }
        }}
        onOpen={handleOpenAsset}
        onDelete={handleDeleteAsset}
      />

      <EffectiveConfigPanel
        prefix={prefix}
        effectiveDesignJson={state.effectiveDesignJson}
        effectiveRenderPolicyJson={state.effectiveRenderPolicyJson}
        effectivePrintProfileJson={state.effectivePrintProfileJson}
        fieldCatalogJson={state.fieldCatalogJson}
        mediaCatalogJson={state.mediaCatalogJson}
      />
    </div>
  );
}
