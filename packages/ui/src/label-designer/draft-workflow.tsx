"use client";

import * as React from "react";
import { Button } from "../button";
import { ErrorBoundary } from "../error-boundary";
import { createUiTranslator } from "../i18n";
import { Input } from "../input";
import { Section } from "../section";
import { Select } from "../select";
import { Textarea } from "../textarea";
import type { AssetItem, DraftRow } from "./types";
import type { TemplateBlock, PageConfig } from "./canvas/canvas-types";
import { isDraftStatus, shortId } from "./utils";
import { useUndoRedo } from "./use-undo-redo";
import { fitBlockToPage, placeAddedBlock } from "./canvas/block-geometry";

const t = createUiTranslator("ui.labelDesigner.draft");

const LazyLabelCanvas = React.lazy(() =>
  import("./canvas/label-canvas").then((mod) => ({ default: mod.LabelCanvas })),
);
const LazyBlockPropertyPanel = React.lazy(() =>
  import("./block-property-panel").then((mod) => ({ default: mod.BlockPropertyPanel })),
);
const LazyBlockCatalogSidebar = React.lazy(() =>
  import("./block-catalog-sidebar").then((mod) => ({ default: mod.BlockCatalogSidebar })),
);
const LazyCanvasLayersPanel = React.lazy(() =>
  import("./canvas/canvas-layers-panel").then((mod) => ({ default: mod.CanvasLayersPanel })),
);

type FieldCatalogItem = {
  path: string;
  label?: string;
  label_ar?: string;
  type?: string;
};

type DraftWorkflowProps = {
  prefix: string;
  canWrite: boolean;
  isBusy: boolean;
  busyAction: string | null;
  selectedScope: { scopeType: string; scopeId: string } | null;

  drafts: DraftRow[];
  selectedDraftId: string;
  draftName: string;
  labelType: string;
  labelTypeOptions: (string | { value: string; label: string })[];
  draftEditor: string;
  draftEditorError: string | null;
  fieldCatalogJson?: string;
  assets?: AssetItem[];

  onDraftSelection: (draftId: string) => void;
  onDraftNameChange: (name: string) => void;
  onLabelTypeChange: (type: string) => void;
  onDraftEditorChange: (value: string) => void;
  onCreateDraft: () => void;
  onSaveDraft: () => void;
  onValidateDraft: () => void;
  onPublishDraft: () => void;
};

function templateKeyFor(templates: Record<string, unknown>, preferred: string) {
  const valid = (key: string) => templates[key] && typeof templates[key] === "object" && !Array.isArray(templates[key]);
  return valid(preferred) ? preferred : Object.keys(templates).find(valid);
}

function parseBlocks(json: string, labelType: string): { blocks: TemplateBlock[]; page: Partial<PageConfig> } {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return { blocks: [], page: {} };
    if (Array.isArray(parsed.blocks)) {
      return { blocks: parsed.blocks, page: parsed.page || {} };
    }
    if (parsed.templates && typeof parsed.templates === "object") {
      const first = templateKeyFor(parsed.templates, labelType);
      if (first && parsed.templates[first]) {
        const template = parsed.templates[first];
        return {
          blocks: Array.isArray(template.blocks) ? template.blocks : [],
          page: template.page || {},
        };
      }
    }
    return { blocks: [], page: {} };
  } catch {
    return { blocks: [], page: {} };
  }
}

function updateBlocksInJson(json: string, newBlocks: TemplateBlock[], labelType: string): string {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return json;
    if (Array.isArray(parsed.blocks)) {
      return JSON.stringify({ ...parsed, blocks: newBlocks }, null, 2);
    }
    if (parsed.templates && typeof parsed.templates === "object") {
      const first = templateKeyFor(parsed.templates, labelType);
      if (first && parsed.templates[first]) {
        const updated = {
          ...parsed,
          templates: {
            ...parsed.templates,
            [first]: {
              ...parsed.templates[first],
              blocks: newBlocks,
            },
          },
        };
        return JSON.stringify(updated, null, 2);
      }
    }
    return JSON.stringify({ ...parsed, blocks: newBlocks }, null, 2);
  } catch {
    return json;
  }
}

function parseFieldCatalog(json: string): FieldCatalogItem[] {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return [];
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.fields) ? parsed.fields : [];
    return items
      .map((item: unknown) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const path = typeof record.path === "string" ? record.path : typeof record.value_path === "string" ? record.value_path : typeof record.key === "string" ? record.key : "";
        if (!path) return null;
        return {
          path,
          label: typeof record.label === "string" ? record.label : typeof record.label_en === "string" ? record.label_en : undefined,
          label_ar: typeof record.label_ar === "string" ? record.label_ar : undefined,
          type: typeof record.type === "string" ? record.type : typeof record.data_type === "string" ? record.data_type : undefined,
        };
      })
      .filter(Boolean) as FieldCatalogItem[];
  } catch {
    return [];
  }
}

export function DraftWorkflow({
  prefix,
  canWrite,
  isBusy,
  busyAction,
  selectedScope,
  drafts,
  selectedDraftId,
  draftName,
  labelType,
  labelTypeOptions,
  draftEditor,
  draftEditorError,
  fieldCatalogJson,
  assets,
  onDraftSelection,
  onDraftNameChange,
  onLabelTypeChange,
  onDraftEditorChange,
  onCreateDraft,
  onSaveDraft,
  onValidateDraft,
  onPublishDraft,
}: DraftWorkflowProps) {
  const selectedDraft = drafts.find((d) => d.id === selectedDraftId) || null;
  const readOnly = !canWrite || isBusy;
  const [editorMode, setEditorMode] = React.useState<"visual" | "code">("visual");
  const [selectedBlockIndex, setSelectedBlockIndex] = React.useState<number | null>(null);

  const { blocks, page } = React.useMemo(() => parseBlocks(draftEditor, labelType), [draftEditor, labelType]);
  const fieldCatalog = React.useMemo(() => parseFieldCatalog(fieldCatalogJson || "{}"), [fieldCatalogJson]);

  // Undo/Redo integration
  const { undo, redo, canUndo, canRedo } = useUndoRedo(draftEditor, onDraftEditorChange, !readOnly, `${selectedScope?.scopeType}:${selectedScope?.scopeId}:${selectedDraftId}`);

  const handleBlocksChange = React.useCallback(
    (newBlocks: TemplateBlock[]) => {
      if (readOnly) return;
      const updated = updateBlocksInJson(draftEditor, newBlocks, labelType);
      onDraftEditorChange(updated);
    },
    [draftEditor, labelType, onDraftEditorChange, readOnly],
  );

  const handleBlockUpdate = React.useCallback(
    (index: number, updates: Partial<TemplateBlock>) => {
      const updated = blocks.map((b, i) => (i === index ? fitBlockToPage({ ...b, ...updates }, page, b) : b));
      handleBlocksChange(updated);
    },
    [blocks, handleBlocksChange, page],
  );

  const handleAddBlock = React.useCallback(
    (block: TemplateBlock) => {
      if (readOnly) return;
      handleBlocksChange([...blocks, placeAddedBlock(block, blocks, page)]);
      setSelectedBlockIndex(blocks.length);
    },
    [blocks, handleBlocksChange, page, readOnly],
  );

  // Multi-select support: derive selected indices from selectedBlockIndex
  const selectedIndices = React.useMemo(
    () => (selectedBlockIndex !== null ? [selectedBlockIndex] : []),
    [selectedBlockIndex],
  );

  return (
    <Section
      title={t("title")}
      description={t("description")}
      actions={
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="soft"
            onClick={() => { if (!readOnly && selectedScope) onCreateDraft(); }}
            disabled={!canWrite || isBusy || !selectedScope}
            data-testid={`${prefix}-create-draft`}
          >
            {busyAction === "create-draft" ? t("creating") : selectedDraft && !isDraftStatus(selectedDraft.status) ? t("forkDraft") : t("createDraft")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => { if (!readOnly && selectedDraft && isDraftStatus(selectedDraft.status)) onSaveDraft(); }}
            disabled={
              !canWrite ||
              isBusy ||
              !selectedDraft ||
              !isDraftStatus(selectedDraft.status)
            }
            data-testid={`${prefix}-save-draft`}
          >
            {busyAction === "save-draft" ? t("saving") : t("saveDraft")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onValidateDraft}
            disabled={isBusy || !selectedDraftId}
            data-testid={`${prefix}-validate-draft`}
          >
            {busyAction === "validate-draft" ? t("validating") : t("validate")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => { if (!readOnly && selectedDraft && isDraftStatus(selectedDraft.status)) onPublishDraft(); }}
            disabled={
              !canWrite ||
              isBusy ||
              !selectedDraft ||
              !isDraftStatus(selectedDraft.status)
            }
            data-testid={`${prefix}-publish-draft`}
          >
            {busyAction === "publish-draft" ? t("publishing") : t("publish")}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1">
            <label
              className="text-xs font-medium text-ui-muted"
              htmlFor={`${prefix}-draft-select`}
            >
              {t("draftLabel")}
            </label>
            <Select
              id={`${prefix}-draft-select`}
              value={selectedDraftId}
              onChange={(event) => onDraftSelection(event.target.value)}
              disabled={isBusy}
              data-testid={`${prefix}-draft-select`}
            >
              <option value="">{t("selectDraft")}</option>
              {drafts.map((draft) => (
                <option key={draft.id} value={draft.id}>
                  {(
                    draft.draft_name ||
                    draft.label_type ||
                    shortId(draft.id)
                  ).trim()}{" "}
                  • {draft.status}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <label
              className="text-xs font-medium text-ui-muted"
              htmlFor={`${prefix}-draft-name`}
            >
              {t("draftName")}
            </label>
            <Input
              id={`${prefix}-draft-name`}
              value={draftName}
              onChange={(event) => { if (!readOnly) onDraftNameChange(event.target.value); }}
              disabled={readOnly}
              placeholder={t("draftNamePlaceholder")}
              data-testid={`${prefix}-draft-name`}
            />
          </div>
          <div className="space-y-1">
            <label
              className="text-xs font-medium text-ui-muted"
              htmlFor={`${prefix}-label-type`}
            >
              {t("labelType")}
            </label>
            <Select
              id={`${prefix}-label-type`}
              value={labelType}
              onChange={(event) => { if (!readOnly) onLabelTypeChange(event.target.value); }}
              disabled={readOnly}
              data-testid={`${prefix}-label-type`}
            >
              {labelTypeOptions.map((option) => {
                const value = typeof option === "string" ? option : option.value;
                const label = typeof option === "string" ? option : option.label;
                return <option key={value} value={value}>{label}</option>;
              })}
            </Select>
          </div>
        </div>

        {/* Visual / Code toggle */}
        <div className="space-y-2">
          <div className="flex items-center gap-1 border-b border-ui-border/50">
            <button
              type="button"
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                editorMode === "visual"
                  ? "border-b-2 border-ui-accent text-ui-accent"
                  : "text-ui-muted hover:text-ui-ink"
              }`}
              onClick={() => setEditorMode("visual")}
              data-testid={`${prefix}-tab-visual`}
            >
              {t("tabVisual")}
            </button>
            <button
              type="button"
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                editorMode === "code"
                  ? "border-b-2 border-ui-accent text-ui-accent"
                  : "text-ui-muted hover:text-ui-ink"
              }`}
              onClick={() => setEditorMode("code")}
              data-testid={`${prefix}-tab-code`}
            >
              {t("tabCode")}
            </button>
          </div>

          {editorMode === "visual" ? (
            <ErrorBoundary
              fallback={
                <div className="flex items-center justify-center rounded-lg border border-ui-danger/30 bg-ui-danger/5 p-8 text-sm text-ui-danger">
                  Visual editor failed to load. Switch to Code tab to continue editing.
                </div>
              }
            >
            <React.Suspense
              fallback={
                <div className="flex items-center justify-center rounded-lg border border-dashed border-ui-border/50 p-8 text-sm text-ui-muted">
                  {t("loadingVisualEditor")}
                </div>
              }
            >
              <div className="grid gap-3 lg:grid-cols-[1fr_240px]">
                <div className="min-w-0">
                  <LazyLabelCanvas
                    blocks={blocks}
                    page={page}
                    readOnly={readOnly}
                    testIdPrefix={`${prefix}-canvas`}
                    onBlocksChange={handleBlocksChange}
                    onSelectBlock={setSelectedBlockIndex}
                    selectedBlockIndex={selectedBlockIndex}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    onUndo={undo}
                    onRedo={redo}
                  />
                </div>
                <div className="space-y-3">
                  <LazyBlockCatalogSidebar
                    fieldCatalog={fieldCatalog}
                    assets={assets || []}
                    testIdPrefix={`${prefix}-catalog`}
                    readOnly={readOnly}
                    onAddBlock={handleAddBlock}
                  />
                  {/* Layers panel */}
                  <LazyCanvasLayersPanel
                    blocks={blocks}
                    selectedIndices={selectedIndices}
                    readOnly={readOnly}
                    onSelect={(i) => setSelectedBlockIndex(i)}
                    onBlocksChange={handleBlocksChange}
                  />
                  {selectedBlockIndex != null && blocks[selectedBlockIndex] ? (
                    <LazyBlockPropertyPanel
                      block={blocks[selectedBlockIndex]}
                      blockIndex={selectedBlockIndex}
                      testIdPrefix={`${prefix}-block-props`}
                      readOnly={readOnly}
                      onUpdate={handleBlockUpdate}
                    />
                  ) : null}
                </div>
              </div>
            </React.Suspense>
            </ErrorBoundary>
          ) : (
            <div className="space-y-1">
              <label
                className="text-xs font-medium text-ui-muted"
                htmlFor={`${prefix}-draft-json`}
              >
                {t("draftJson")}
              </label>
              <Textarea
                id={`${prefix}-draft-json`}
                value={draftEditor}
                onChange={(event) => { if (!readOnly) onDraftEditorChange(event.target.value); }}
                disabled={readOnly}
                rows={22}
                className="font-mono text-xs"
                data-testid={`${prefix}-draft-json`}
              />
            </div>
          )}

          {draftEditorError ? (
            <p
              className="text-xs text-ui-danger"
              data-testid={`${prefix}-draft-json-error`}
            >
              {draftEditorError}
            </p>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
