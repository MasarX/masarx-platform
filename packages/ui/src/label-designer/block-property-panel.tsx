"use client";

import * as React from "react";
import { createUiTranslator } from "../i18n";
import { Input } from "../input";
import { Select } from "../select";
import type { TemplateBlock } from "./canvas/canvas-types";
import { BARCODE_REGISTRY, validateBarcodeData } from "./canvas/barcode-types";
import { assessBarcodeQuality } from "./canvas/barcode-quality";
import { ColorPickerInput } from "./color-picker-input";
import { FontSelector } from "./font-selector";

const t = createUiTranslator("ui.labelDesigner.blockProps");

type BlockPropertyPanelProps = {
  block: TemplateBlock;
  blockIndex: number;
  testIdPrefix?: string;
  dpi?: number;
  readOnly?: boolean;
  onUpdate: (index: number, updates: Partial<TemplateBlock>) => void;
};

function numField(
  label: string,
  value: number | undefined,
  onChange: (v: number) => void,
  id: string,
  disabled = false,
) {
  return (
    <div className="space-y-0.5">
      <label className="text-[10px] font-medium uppercase tracking-wide text-ui-muted" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        disabled={disabled}
        className="h-7 text-xs"
      />
    </div>
  );
}

function textField(
  label: string,
  value: string | undefined,
  onChange: (v: string) => void,
  id: string,
  placeholder?: string,
  disabled = false,
) {
  return (
    <div className="space-y-0.5">
      <label className="text-[10px] font-medium uppercase tracking-wide text-ui-muted" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="h-7 text-xs"
      />
    </div>
  );
}

function QualityBadge({ quality }: { quality: "ok" | "at_risk" | "unscannable" }) {
  const colors = {
    ok: "bg-green-100 text-green-700",
    at_risk: "bg-yellow-100 text-yellow-700",
    unscannable: "bg-red-100 text-red-700",
  };
  const labels = {
    ok: t("barcodeQualityOk"),
    at_risk: t("barcodeQualityWarn"),
    unscannable: t("barcodeQualityBad"),
  };
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${colors[quality]}`}>
      {labels[quality]}
    </span>
  );
}

function ValidationBadge({ valid }: { valid: boolean }) {
  return (
    <span
      className={`inline-block rounded px-1 py-0.5 text-[10px] font-medium ${
        valid ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
      }`}
    >
      {valid ? t("barcodeDataValid") : t("barcodeDataInvalid")}
    </span>
  );
}

function barcodeTypeForControl(value: string | undefined): string {
  const normalized = (value || "code128").toLowerCase();
  if (normalized === "code128") return "code128";
  if (normalized === "ean13" || normalized === "ean-13") return "ean13";
  if (normalized === "qr") return "qr";
  return normalized;
}

function rendererBarcodeType(value: string): string {
  if (value === "qr") return "QR";
  if (value === "ean13") return "EAN13";
  return value.toUpperCase();
}

export function BlockPropertyPanel({
  block,
  blockIndex,
  testIdPrefix,
  dpi = 203,
  readOnly = false,
  onUpdate,
}: BlockPropertyPanelProps) {
  const prefix = testIdPrefix || "block-props";
  const id = (name: string) => `${prefix}-${blockIndex}-${name}`;
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const set = React.useCallback(
    (updates: Partial<TemplateBlock>) => {
      if (readOnly) return;
      onUpdate(blockIndex, updates);
    },
    [blockIndex, onUpdate, readOnly],
  );

  const barcodeType = barcodeTypeForControl(block.barcode_type);
  const barcodeData = block.fallback || block.value_path || "";
  const dataValid = block.type === "barcode" ? validateBarcodeData(barcodeType, barcodeData) : true;
  const quality = block.type === "barcode" ? assessBarcodeQuality(block.width || 80, barcodeType, dpi) : null;

  return (
    <div className="space-y-3 rounded-lg border border-ui-border/50 bg-ui-paper/50 p-3" data-testid={`${prefix}-panel`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-ui-ink capitalize">
          {block.type === "text" ? t("textBlock") : block.type === "barcode" ? t("barcodeBlock") : block.type === "image" ? t("imageBlock") : block.type === "line" ? t("lineBlock") : t("rectBlock")}
        </span>
        <div className="flex items-center gap-1">
          {quality ? <QualityBadge quality={quality} /> : null}
          <span className="text-[10px] text-ui-muted">#{blockIndex}</span>
        </div>
      </div>

      {/* Lock toggle */}
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-[10px] text-ui-muted">
          <input
            type="checkbox"
            checked={block.locked ?? false}
            onChange={(e) => set({ locked: e.target.checked })}
            disabled={readOnly}
            className="h-3 w-3"
          />
          {block.locked ? t("locked") : t("unlocked")}
        </label>
      </div>

      {/* Name */}
      {textField(t("blockName"), block.name, (v) => set({ name: v }), id("name"), `${block.type} #${blockIndex}`, readOnly)}

      {/* Position + Size */}
      <div className="grid grid-cols-4 gap-2">
        {numField("X", block.x, (v) => set({ x: v }), id("x"), readOnly)}
        {numField("Y", block.y, (v) => set({ y: v }), id("y"), readOnly)}
        {numField("W", block.width, (v) => set({ width: v }), id("w"), readOnly)}
        {numField("H", block.height, (v) => set({ height: v }), id("h"), readOnly)}
      </div>

      {/* Rotation */}
      {numField(t("rotation"), block.rotation, (v) => set({ rotation: v }), id("rotation"), readOnly)}

      {/* Type-specific fields */}
      {block.type === "text" ? (
        <div className="space-y-2">
          {textField(t("valuePath"), block.value_path, (v) => set({ value_path: v }), id("value_path"), "e.g. shipment.tracking_number", readOnly)}
          {textField(t("fallback"), block.fallback, (v) => set({ fallback: v }), id("fallback"), undefined, readOnly)}
          <div className="grid grid-cols-2 gap-2">
            {numField(t("fontSize"), block.font_size, (v) => set({ font_size: v }), id("font_size"), readOnly)}
            <FontSelector
              value={block.font || "regular"}
              onChange={(v) => set({ font: v })}
              id={id("font")}
              label={t("font")}
              disabled={readOnly}
            />
          </div>
          <ColorPickerInput
            value={block.color}
            onChange={(v) => set({ color: v })}
            id={id("color")}
            label={t("color")}
            disabled={readOnly}
          />
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-0.5">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ui-muted" htmlFor={id("align")}>
                {t("align")}
              </label>
              <Select
                id={id("align")}
                value={block.align || "left"}
                onChange={(e) => set({ align: e.target.value as "left" | "center" | "right" })}
                disabled={readOnly}
                className="h-7 text-xs"
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </Select>
            </div>
            <div className="space-y-0.5">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ui-muted" htmlFor={id("valign")}>
                {t("valign")}
              </label>
              <Select
                id={id("valign")}
                value={block.valign || "top"}
                onChange={(e) => set({ valign: e.target.value as "top" | "middle" | "bottom" })}
                disabled={readOnly}
                className="h-7 text-xs"
              >
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </Select>
            </div>
            <div className="flex items-end pb-0.5">
              <label className="flex items-center gap-1 text-[10px] text-ui-muted">
                <input
                  type="checkbox"
                  checked={block.wrap ?? false}
                  onChange={(e) => set({ wrap: e.target.checked })}
                  disabled={readOnly}
                  className="h-3 w-3"
                />
                {t("wrap")}
              </label>
            </div>
          </div>
        </div>
      ) : null}

      {block.type === "barcode" ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {textField(t("valuePath"), block.value_path, (v) => set({ value_path: v }), id("value_path"), "e.g. shipment.tracking_number", readOnly)}
          </div>
          <div className="flex items-center gap-2">
            {textField(t("fallback"), block.fallback, (v) => set({ fallback: v }), id("fallback"), undefined, readOnly)}
            {barcodeData ? <ValidationBadge valid={dataValid} /> : null}
          </div>
          <div className="space-y-0.5">
            <label className="text-[10px] font-medium uppercase tracking-wide text-ui-muted" htmlFor={id("barcode_type")}>
              {t("barcodeType")}
            </label>
            <Select
              id={id("barcode_type")}
              value={barcodeType}
              onChange={(e) => set({ barcode_type: rendererBarcodeType(e.target.value) })}
              disabled={readOnly}
              className="h-7 text-xs"
            >
              {Object.entries(BARCODE_REGISTRY).map(([key, config]) => (
                <option key={key} value={key}>
                  {config.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Advanced barcode settings */}
          <button
            type="button"
            className="text-[10px] text-blue-600 hover:underline"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? `- ${t("advancedSettings")}` : `+ ${t("advancedSettings")}`}
          </button>
          {showAdvanced ? (
            <div className="space-y-2 rounded border border-ui-border/30 bg-gray-50 p-2">
              <div className="grid grid-cols-2 gap-2">
                {numField(t("moduleWidth"), block.module_width, (v) => set({ module_width: v }), id("module_width"), readOnly)}
                {numField(t("quietZone"), block.quiet_zone_modules, (v) => set({ quiet_zone_modules: v }), id("quiet_zone"), readOnly)}
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-[10px] text-ui-muted">
                  <input
                    type="checkbox"
                    checked={block.human_readable !== false}
                    onChange={(e) => set({ human_readable: e.target.checked })}
                    disabled={readOnly}
                    className="h-3 w-3"
                  />
                  {t("humanReadable")}
                </label>
              </div>
              {barcodeType === "qr" ? (
                <div className="space-y-0.5">
                  <label className="text-[10px] font-medium uppercase tracking-wide text-ui-muted" htmlFor={id("error_correction")}>
                    {t("errorCorrection")}
                  </label>
                  <Select
                    id={id("error_correction")}
                    value={block.error_correction || "M"}
                    onChange={(e) => set({ error_correction: e.target.value as "L" | "M" | "Q" | "H" })}
                    disabled={readOnly}
                    className="h-7 text-xs"
                  >
                    <option value="L">L (7%)</option>
                    <option value="M">M (15%)</option>
                    <option value="Q">Q (25%)</option>
                    <option value="H">H (30%)</option>
                  </Select>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {block.type === "image" ? (
        <div className="space-y-2">
          {textField(t("assetRef"), block.asset_ref, (v) => set({ asset_ref: v }), id("asset_ref"), "e.g. logo_png", readOnly)}
          {textField(t("valuePath"), block.value_path, (v) => set({ value_path: v }), id("value_path"), undefined, readOnly)}
        </div>
      ) : null}

      {block.type === "line" || block.type === "rect" ? (
        <div className="space-y-2">
          <ColorPickerInput
            value={block.color}
            onChange={(v) => set({ color: v })}
            id={id("color")}
            label={t("color")}
            disabled={readOnly}
          />
          {numField(t("stroke"), block.stroke_width, (v) => set({ stroke_width: v }), id("stroke_width"), readOnly)}
          {block.type === "rect" ? (
            <ColorPickerInput
              value={block.fill_color}
              onChange={(v) => set({ fill_color: v })}
              id={id("fill_color")}
              label={t("fill")}
              disabled={readOnly}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
