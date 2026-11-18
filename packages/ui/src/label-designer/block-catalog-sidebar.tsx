"use client";

import * as React from "react";
import { Button } from "../button";
import { createUiTranslator } from "../i18n";
import type { BlockType, TemplateBlock } from "./canvas/canvas-types";

const t = createUiTranslator("ui.labelDesigner.canvas");

type BlockCatalogSidebarProps = {
  fieldCatalog: FieldCatalogItem[];
  assets: { name: string; path: string }[];
  testIdPrefix?: string;
  readOnly?: boolean;
  onAddBlock: (block: TemplateBlock) => void;
};

type FieldCatalogItem = {
  path: string;
  label?: string;
  label_ar?: string;
  type?: string;
};

type BlockTemplate = {
  type: BlockType;
  label: string;
  defaults: Partial<TemplateBlock>;
};

const BLOCK_TEMPLATES: BlockTemplate[] = [
  {
    type: "text",
    label: "Text",
    defaults: { type: "text", x: 10, y: 10, width: 150, height: 20, font_size: 12, fallback: "Text" },
  },
  {
    type: "barcode",
    label: "Barcode",
    defaults: { type: "barcode", x: 10, y: 10, width: 180, height: 60, barcode_type: "code128", value_path: "barcode_value", fallback: "TRACKING", human_readable: false },
  },
  {
    type: "barcode",
    label: "QR Code",
    defaults: { type: "barcode", x: 10, y: 10, width: 72, height: 72, barcode_type: "qr", value_path: "barcode_value", fallback: "TRACKING", human_readable: false },
  },
  {
    type: "barcode",
    label: "EAN-13",
    defaults: { type: "barcode", x: 10, y: 10, width: 180, height: 60, barcode_type: "ean13", value_path: "barcode_value", fallback: "590123412345", human_readable: false },
  },
  {
    type: "image",
    label: "Image",
    defaults: { type: "image", x: 10, y: 10, width: 80, height: 40 },
  },
  {
    type: "line",
    label: "Line",
    defaults: { type: "line", x: 10, y: 10, width: 200, height: 0, stroke_width: 1 },
  },
  {
    type: "rect",
    label: "Rectangle",
    defaults: { type: "rect", x: 10, y: 10, width: 100, height: 60, stroke_width: 1 },
  },
];

function makeBlock(template: BlockTemplate): TemplateBlock {
  return {
    ...template.defaults,
    type: template.type,
    x: template.defaults.x ?? 10,
    y: template.defaults.y ?? 10,
  } as TemplateBlock;
}

export function BlockCatalogSidebar({
  fieldCatalog,
  assets,
  testIdPrefix,
  readOnly = false,
  onAddBlock,
}: BlockCatalogSidebarProps) {
  const prefix = testIdPrefix || "block-catalog";
  const [search, setSearch] = React.useState("");

  const filteredFields = React.useMemo(() => {
    if (!search.trim()) return fieldCatalog;
    const q = search.toLowerCase();
    return fieldCatalog.filter(
      (f) =>
        f.path.toLowerCase().includes(q) ||
        (f.label && f.label.toLowerCase().includes(q)) ||
        (f.label_ar && f.label_ar.includes(q)),
    );
  }, [fieldCatalog, search]);

  const handleDragStart = React.useCallback(
    (e: React.DragEvent, block: TemplateBlock) => {
      if (readOnly) { e.preventDefault(); return; }
      e.dataTransfer.setData("application/json", JSON.stringify(block));
      e.dataTransfer.effectAllowed = "copy";
    },
    [readOnly],
  );

  const handleAddFieldAsText = React.useCallback(
    (field: FieldCatalogItem) => {
      if (readOnly) return;
      onAddBlock({
        type: "text",
        x: 10,
        y: 10,
        width: 150,
        height: 20,
        font_size: 12,
        value_path: field.path,
        fallback: field.label || field.path,
      });
    },
    [onAddBlock, readOnly],
  );

  const handleAddAssetBlock = React.useCallback(
    (asset: { name: string; path: string }) => {
      if (readOnly) return;
      onAddBlock({
        type: "image",
        x: 10,
        y: 10,
        width: 80,
        height: 40,
        asset_ref: asset.name,
      });
    },
    [onAddBlock, readOnly],
  );

  return (
    <div className="space-y-3" data-testid={`${prefix}-sidebar`}>
      {/* Block types */}
      <div className="space-y-1">
        <p className="text-[10px] font-semibold tracking-wide text-ui-muted">
          {t("blocks")}
        </p>
        <div className="grid grid-cols-2 gap-1">
          {BLOCK_TEMPLATES.map((template, i) => {
            const block = makeBlock(template);
            return (
              <Button
                key={i}
                type="button"
                size="sm"
                variant="ghost"
                className="justify-start text-xs cursor-grab active:cursor-grabbing"
                draggable={!readOnly}
                disabled={readOnly}
                onDragStart={(e) => handleDragStart(e, block)}
                onClick={() => { if (!readOnly) onAddBlock(block); }}
              >
                {template.label}
              </Button>
            );
          })}
        </div>
      </div>

      {/* Field catalog */}
      <div className="space-y-1">
        <p className="text-[10px] font-semibold tracking-wide text-ui-muted">
          {t("fields", { count: fieldCatalog.length })}
        </p>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchFields")}
          className="w-full rounded border border-ui-border/50 bg-ui-paper/50 px-2 py-1 text-xs text-ui-ink placeholder:text-ui-muted focus:outline-none focus:ring-1 focus:ring-blue-500"
          data-testid={`${prefix}-search`}
        />
        <div className="max-h-48 space-y-0.5 overflow-y-auto">
          {filteredFields.map((field) => {
            const fieldBlock: TemplateBlock = {
              type: "text",
              x: 10,
              y: 10,
              width: 150,
              height: 20,
              font_size: 12,
              value_path: field.path,
              fallback: field.label || field.path,
            };
            return (
              <button
                key={field.path}
                type="button"
                className="group flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-ui-ink hover:bg-blue-50 cursor-grab active:cursor-grabbing"
                draggable={!readOnly}
                disabled={readOnly}
                onDragStart={(e) => handleDragStart(e, fieldBlock)}
                onClick={() => handleAddFieldAsText(field)}
                title={field.label_ar ? `${field.label} / ${field.label_ar}` : field.label}
              >
                <span className="min-w-0 truncate font-mono text-[11px]">
                  {field.path}
                </span>
                <span className="ms-1 hidden text-[10px] text-ui-muted group-hover:inline">
                  {t("addBlock")}
                </span>
              </button>
            );
          })}
          {filteredFields.length === 0 ? (
            <p className="px-2 py-1 text-[10px] text-ui-muted">{t("noFieldsMatch")}</p>
          ) : null}
        </div>
      </div>

      {/* Assets */}
      {assets.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold tracking-wide text-ui-muted">
            Assets ({assets.length})
          </p>
          <div className="max-h-32 space-y-0.5 overflow-y-auto">
            {assets.map((asset) => {
              const assetBlock: TemplateBlock = {
                type: "image",
                x: 10,
                y: 10,
                width: 80,
                height: 40,
                asset_ref: asset.name,
              };
              return (
                <button
                  key={asset.path}
                  type="button"
                  className="group flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs text-ui-ink hover:bg-blue-50 cursor-grab active:cursor-grabbing"
                  draggable={!readOnly}
                  disabled={readOnly}
                  onDragStart={(e) => handleDragStart(e, assetBlock)}
                  onClick={() => handleAddAssetBlock(asset)}
                >
                  <span className="min-w-0 truncate">{asset.name}</span>
                  <span className="ms-1 hidden text-[10px] text-ui-muted group-hover:inline">
                    {t("addBlock")}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
