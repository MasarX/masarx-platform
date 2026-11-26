"use client";

import * as React from "react";
import { Button } from "../button";
import { createUiTranslator } from "../i18n";
import type { AssetItem } from "./types";
import { AssetThumbnail } from "./asset-thumbnail";

const t = createUiTranslator("ui.labelDesigner.assets");

type AssetPickerModalProps = {
  open: boolean;
  assets: AssetItem[];
  testIdPrefix?: string;
  onSelect: (asset: AssetItem) => void;
  onClose: () => void;
};

export function AssetPickerModal({
  open,
  assets,
  testIdPrefix,
  onSelect,
  onClose,
}: AssetPickerModalProps) {
  const prefix = testIdPrefix || "asset-picker";
  const [search, setSearch] = React.useState("");

  const filtered = React.useMemo(() => {
    if (!search.trim()) return assets;
    const q = search.toLowerCase();
    return assets.filter((a) => a.name.toLowerCase().includes(q));
  }, [assets, search]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid={`${prefix}-overlay`}
    >
      <div
        className="w-full max-w-md rounded-xl border border-ui-border bg-ui-surface p-4 shadow-xl"
        data-testid={`${prefix}-dialog`}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ui-ink">{t("selectAsset")}</h3>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchAssets")}
          className="mb-3 w-full rounded border border-ui-border/50 bg-ui-paper/50 px-3 py-1.5 text-xs text-ui-ink placeholder:text-ui-muted focus:outline-none focus:ring-1 focus:ring-ui-accent"
          data-testid={`${prefix}-search`}
        />

        <div className="grid grid-cols-4 gap-2 overflow-y-auto" style={{ maxHeight: 320 }}>
          {filtered.map((asset) => (
            <AssetThumbnail
              key={asset.path}
              asset={asset}
              testIdPrefix={`${prefix}-thumb`}
              onClick={() => {
                onSelect(asset);
                onClose();
              }}
            />
          ))}
          {filtered.length === 0 ? (
            <p className="col-span-4 py-8 text-center text-xs text-ui-muted">
              {t("noAssetsFound")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
