"use client";

import * as React from "react";
import { Button } from "../button";
import { createUiTranslator } from "../i18n";
import { Section } from "../section";
import type { AssetItem } from "./types";
import { AssetDropzone } from "./asset-dropzone";
import { AssetThumbnail } from "./asset-thumbnail";

const t = createUiTranslator("ui.labelDesigner.assets");

type AssetManagerProps = {
  prefix: string;
  isBusy: boolean;
  canWrite: boolean;
  assets: AssetItem[];
  assetsError: string | null;
  onUpload: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onUploadFiles?: (files: File[]) => void;
  onOpen: (path: string) => void;
  onDelete: (path: string) => void;
};

export function AssetManager({
  prefix,
  isBusy,
  canWrite,
  assets,
  assetsError,
  onUpload,
  onUploadFiles,
  onOpen,
  onDelete,
}: AssetManagerProps) {
  const handleDropzoneFiles = React.useCallback(
    (files: File[]) => {
      if (onUploadFiles) {
        for (const file of files) onUploadFiles([file]);
        return;
      }
      // Fallback: use the legacy input-based upload for the first file
      // This path won't be hit if onUploadFiles is provided
    },
    [onUploadFiles],
  );

  return (
    <Section
      title={t("title")}
      description={t("description")}
      actions={
        !onUploadFiles ? (
          <input
            type="file"
            accept="image/*"
            onChange={onUpload}
            disabled={isBusy || !canWrite}
            data-testid={`${prefix}-asset-upload`}
          />
        ) : null
      }
    >
      {/* Drag-and-drop upload zone */}
      {onUploadFiles ? (
        <AssetDropzone
          disabled={isBusy || !canWrite}
          testIdPrefix={`${prefix}-dropzone`}
          onFiles={handleDropzoneFiles}
        />
      ) : null}

      {assetsError ? (
        <p
          className="text-xs text-ui-danger"
          data-testid={`${prefix}-assets-error`}
        >
          {assetsError}
        </p>
      ) : null}

      {assets.length === 0 ? (
        <p className="text-sm text-ui-muted">
          {t("noAssets")}
        </p>
      ) : (
        <div className="space-y-2" data-testid={`${prefix}-assets-list`}>
          {/* Thumbnail grid */}
          <div className="flex flex-wrap gap-2">
            {assets.map((asset) => (
              <AssetThumbnail
                key={asset.path}
                asset={asset}
                testIdPrefix={`${prefix}-thumb`}
                onClick={() => onOpen(asset.path)}
              />
            ))}
          </div>

          {/* List view with actions */}
          {assets.map((asset) => (
            <div
              key={asset.path}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ui-border/70 bg-ui-paper/70 px-3 py-2"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-medium text-ui-ink">
                  {asset.name}
                </p>
                <p className="truncate font-mono text-xs text-ui-muted">
                  {asset.path}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpen(asset.path)}
                  disabled={isBusy}
                >
                  {t("open")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onDelete(asset.path)}
                  disabled={isBusy || !canWrite}
                >
                  {t("delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
