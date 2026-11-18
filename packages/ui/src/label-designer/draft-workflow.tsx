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
import { shortId } from "./utils";
import { useUndoRedo } from "./use-undo-redo";

const t = createUiTranslator("ui.labelDesigner.draft");

const LazyLabelCanvas = React.lazy(() =>
  import("./label-canvas").then((mod) => ({ default: mod.LabelCanvas })),
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

type LabelTypeOption = string | {
  value: string;
  label?: string | null;
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
  labelTypeOptions: LabelTypeOption[];
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

function templateKeyFor(parsed: Record<string, unknown>, preferredLabelType?: string | null): string | null {
  const templates = parsed.templates;
  if (!templates || typeof templates !== "object" || Array.isArray(templates)) return null;
  const templateMap = templates as Record<string, unknown>;
  const preferred = String(preferredLabelType || "").trim();
  if (preferred && templateMap[preferred] && typeof templateMap[preferred] === "object" && !Array.isArray(templateMap[preferred])) {
    return preferred;
  }
  return Object.keys(templateMap).find((key) => {
    const value = templateMap[key];
    return !!value && typeof value === "object" && !Array.isArray(value);
  }) || null;
}

function parseBlocks(json: string, preferredLabelType?: string | null): { blocks: TemplateBlock[]; page: Partial<PageConfig> } {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return { blocks: [], page: {} };
    if (Array.isArray(parsed.blocks)) {
      return { blocks: parsed.blocks, page: parsed.page || {} };
    }
    const activeKey = templateKeyFor(parsed, preferredLabelType);
    if (activeKey && parsed.templates && typeof parsed.templates === "object") {
      const templates = parsed.templates as Record<string, unknown>;
      if (templates[activeKey]) {
        const template = templates[activeKey] as Record<string, unknown>;
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

function updateBlocksInJson(json: string, newBlocks: TemplateBlock[], preferredLabelType?: string | null): string {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return json;
    if (Array.isArray(parsed.blocks)) {
      return JSON.stringify({ ...parsed, blocks: newBlocks }, null, 2);
    }
    const activeKey = templateKeyFor(parsed, preferredLabelType);
    if (activeKey && parsed.templates && typeof parsed.templates === "object") {
      const templates = parsed.templates as Record<string, Record<string, unknown>>;
      if (templates[activeKey]) {
        const updated = {
          ...parsed,
          templates: {
            ...templates,
            [activeKey]: {
              ...templates[activeKey],
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

const COLLIDABLE_BLOCK_TYPES = new Set(["text", "barcode", "image"]);

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function blockHeight(block: TemplateBlock): number {
  if (typeof block.height === "number" && Number.isFinite(block.height) && block.height > 0) {
    return block.height;
  }
  if (block.type === "text") return numberOr(block.font_size, 12) + 4;
  if (block.type === "barcode") return 60;
  if (block.type === "image") return 40;
  return 20;
}

function blockWidth(block: TemplateBlock): number {
  if (typeof block.width === "number" && Number.isFinite(block.width) && block.width > 0) {
    return block.width;
  }
  if (block.type === "barcode") return 180;
  if (block.type === "image") return 80;
  return 150;
}

function normalizeBarcodeType(value: string | undefined): string {
  const normalized = (value || "CODE128").trim().toLowerCase();
  if (normalized === "qr") return "QR";
  if (normalized === "ean13" || normalized === "ean-13") return "EAN13";
  return "CODE128";
}

function rendererSafeBlock(block: TemplateBlock): TemplateBlock {
  if (block.type === "text") {
    return {
      ...block,
      width: blockWidth(block),
      height: blockHeight(block),
      font_size: numberOr(block.font_size, 12),
      fallback: block.fallback || block.value_path || "Text",
    };
  }
  if (block.type === "barcode") {
    const barcodeType = normalizeBarcodeType(block.barcode_type);
    return {
      ...block,
      width: blockWidth(block),
      height: blockHeight(block),
      barcode_type: barcodeType,
      value_path: block.value_path || "barcode_value",
      fallback: block.fallback || (barcodeType === "EAN13" ? "590123412345" : "TRACKING"),
      human_readable: block.human_readable ?? false,
    };
  }
  if (block.type === "image") {
    return { ...block, width: blockWidth(block), height: blockHeight(block) };
  }
  return block;
}

function placeAddedBlock(block: TemplateBlock, existingBlocks: TemplateBlock[], page: Partial<PageConfig>): TemplateBlock {
  const next = rendererSafeBlock(block);
  if (!COLLIDABLE_BLOCK_TYPES.has(next.type)) return next;

  const gap = 8;
  const pageHeight = numberOr(page.height_inch, 6) * 72;
  const collidableBottoms = existingBlocks
    .filter((item) => COLLIDABLE_BLOCK_TYPES.has(item.type))
    .map((item) => numberOr(item.y, 10) + blockHeight(item));
  const nextY = collidableBottoms.length > 0 ? Math.max(...collidableBottoms) + gap : numberOr(next.y, 10);
  const safeY = Math.min(Math.max(nextY, 10), Math.max(10, pageHeight - blockHeight(next) - gap));
  return { ...next, x: numberOr(next.x, 10), y: safeY };
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
        const path = typeof record.path === "string"
          ? record.path
          : typeof record.value_path === "string"
            ? record.value_path
            : typeof record.key === "string"
              ? record.key
              : "";
        if (!path) return null;
        return {
          path,
          label: typeof record.label === "string"
            ? record.label
            : typeof record.label_en === "string"
              ? record.label_en
              : undefined,
          label_ar: typeof record.label_ar === "string"
            ? record.label_ar
            : undefined,
          type: typeof record.type === "string"
            ? record.type
            : typeof record.data_type === "string"
              ? record.data_type
              : undefined,
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
  const [editorMode, setEditorMode] = React.useState<"visual" | "code">("visual");
  const [selectedBlockIndex, setSelectedBlockIndex] = React.useState<number | null>(null);

  const { blocks, page } = React.useMemo(() => parseBlocks(draftEditor, labelType), [draftEditor, labelType]);
  const fieldCatalog = React.useMemo(() => parseFieldCatalog(fieldCatalogJson || "{}"), [fieldCatalogJson]);
  const normalizedLabelTypeOptions = React.useMemo(
    () => labelTypeOptions
      .map((option) => {
        if (typeof option === "string") return { value: option, label: option };
        return {
          value: String(option.value || ""),
          label: String(option.label || option.value || ""),
        };
      })
      .filter((option) => option.value),
    [labelTypeOptions],
  );

  // Undo/Redo integration
  const { undo, redo, canUndo, canRedo } = useUndoRedo(draftEditor, onDraftEditorChange);

  const handleBlocksChange = React.useCallback(
    (newBlocks: TemplateBlock[]) => {
      const updated = updateBlocksInJson(draftEditor, newBlocks, labelType);
      onDraftEditorChange(updated);
    },
    [draftEditor, labelType, onDraftEditorChange],
  );

  const handleBlockUpdate = React.useCallback(
    (index: number, updates: Partial<TemplateBlock>) => {
      const updated = blocks.map((b, i) => (i === index ? { ...b, ...updates } : b));
      handleBlocksChange(updated);
    },
    [blocks, handleBlocksChange],
  );

  const handleAddBlock = React.useCallback(
    (block: TemplateBlock) => {
      const placedBlock = placeAddedBlock(block, blocks, page);
      handleBlocksChange([...blocks, placedBlock]);
      setSelectedBlockIndex(blocks.length);
    },
    [blocks, handleBlocksChange, page],
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
            onClick={onCreateDraft}
            disabled={!canWrite || isBusy || !selectedScope}
            data-testid={`${prefix}-create-draft`}
          >
            {busyAction === "create-draft" ? t("creating") : t("createDraft")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSaveDraft}
            disabled={
              !canWrite ||
              isBusy ||
              !selectedScope
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
            onClick={onPublishDraft}
            disabled={
              !canWrite ||
              isBusy ||
              !selectedScope ||
              (!selectedDraft && !draftEditor.trim())
            }
            data-testid={`${prefix}-publish-draft`}
          >
            {busyAction === "publish-draft" ? t("publishing") : "Publish active design"}
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
              onChange={(event) => {
                if (canWrite && !isBusy) onDraftNameChange(event.target.value);
              }}
              placeholder={t("draftNamePlaceholder")}
              disabled={!canWrite || isBusy}
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
              onChange={(event) => onLabelTypeChange(event.target.value)}
              disabled={!canWrite || isBusy || normalizedLabelTypeOptions.length === 0}
              data-testid={`${prefix}-label-type`}
            >
              {normalizedLabelTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
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
                  ? "border-b-2 border-blue-600 text-blue-600"
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
                  ? "border-b-2 border-blue-600 text-blue-600"
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
                    readOnly={!canWrite}
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
                    readOnly={!canWrite}
                    onAddBlock={handleAddBlock}
                  />
                  {/* Layers panel */}
                  <LazyCanvasLayersPanel
                    blocks={blocks}
                    selectedIndices={selectedIndices}
                    readOnly={!canWrite}
                    onSelect={(i) => setSelectedBlockIndex(i)}
                    onBlocksChange={handleBlocksChange}
                  />
                  {selectedBlockIndex != null && blocks[selectedBlockIndex] ? (
                    <LazyBlockPropertyPanel
                      block={blocks[selectedBlockIndex]}
                      blockIndex={selectedBlockIndex}
                      testIdPrefix={`${prefix}-block-props`}
                      readOnly={!canWrite}
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
                Design JSON
              </label>
              <Textarea
                id={`${prefix}-draft-json`}
                value={draftEditor}
                onChange={(event) => {
                  if (canWrite && !isBusy) onDraftEditorChange(event.target.value);
                }}
                rows={22}
                className="font-mono text-xs"
                disabled={!canWrite || isBusy}
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
