"use client";

import * as React from "react";
import { createUiTranslator } from "../i18n";

const t = createUiTranslator("ui.labelDesigner.assets");

type AssetDropzoneProps = {
  disabled?: boolean;
  maxSizeBytes?: number;
  accept?: string;
  testIdPrefix?: string;
  onFiles: (files: File[]) => void;
};

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5MB

export function AssetDropzone({
  disabled = false,
  maxSizeBytes = DEFAULT_MAX_SIZE,
  accept = "image/*",
  testIdPrefix,
  onFiles,
}: AssetDropzoneProps) {
  const prefix = testIdPrefix || "asset-dropzone";
  const [isDragOver, setIsDragOver] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const validateAndEmit = React.useCallback(
    (files: File[]) => {
      setError(null);
      const valid: File[] = [];
      for (const file of files) {
        if (file.size > maxSizeBytes) {
          setError(t("fileTooLarge", { name: file.name, size: Math.round(maxSizeBytes / 1024 / 1024) }));
          continue;
        }
        valid.push(file);
      }
      if (valid.length > 0) onFiles(valid);
    },
    [maxSizeBytes, onFiles],
  );

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files);
      validateAndEmit(files);
    },
    [disabled, validateAndEmit],
  );

  const handleDragOver = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragOver(true);
    },
    [disabled],
  );

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleInputChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      e.currentTarget.value = "";
      if (files.length > 0) validateAndEmit(files);
    },
    [validateAndEmit],
  );

  return (
    <div className="space-y-1">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !disabled && inputRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
          disabled
            ? "cursor-not-allowed border-ui-border/30 bg-ui-paper/30 text-ui-muted/50"
            : isDragOver
              ? "border-ui-accent bg-ui-accent-soft"
              : "border-ui-border/50 bg-ui-paper/30 text-ui-muted hover:border-ui-accent/60 hover:bg-ui-accent-soft/30"
        }`}
        data-testid={`${prefix}-zone`}
      >
        <svg
          className="mb-2 h-8 w-8 text-ui-muted/60"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path d="M12 16V4m0 0L8 8m4-4l4 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="text-xs font-medium">
          {isDragOver ? t("dropzoneHover") : t("dropzoneText")}
        </p>
        <p className="mt-0.5 text-[10px]">
          {t("maxSize", { size: Math.round(maxSizeBytes / 1024 / 1024) })}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          onChange={handleInputChange}
          className="hidden"
          disabled={disabled}
          data-testid={`${prefix}-input`}
        />
      </div>
      {error ? (
        <p className="text-xs text-ui-danger" data-testid={`${prefix}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
