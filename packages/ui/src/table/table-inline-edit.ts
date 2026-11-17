"use client";
import * as React from "react";
import { createUiClient } from "@masarx/api";
import {
  resolveColumnLabelByKey,
  type ResourceColumn,
} from "./columns";
import type { EditConfig, InlineEditState, InlineEditType } from "./editing";
import type { TranslateFn } from "./types";
import {
  applyOptimisticRowPatch,
  rollbackOptimisticRowPatch,
} from "./optimistic";
import { formatUiError } from "../utils";

type ToastFn = (props: {
  title: string;
  description?: string;
  tone?: "success" | "error" | "warning" | "info";
}) => void;

type InlineEditParams = {
  editConfigByKey: Map<string, EditConfig>;
  inlineEditEnabled: boolean;
  columnsByKey: Map<string, ResourceColumn>;
  resolvedResourceKey: string | null;
  resolvedItems: Record<string, unknown>[];
  idKey: string | null;
  t: TranslateFn;
  toast: ToastFn;
  startTransition: React.TransitionStartFunction;
  setRowOverrides: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, unknown>>>
  >;
};

type InlineEditHandlers = {
  inlineEdit: InlineEditState | null;
  startInlineEdit: (
    rowId: string,
    column: ResourceColumn,
    value: unknown
  ) => void;
  updateInlineEditValue: (value: string | boolean | string[]) => void;
  cancelInlineEdit: () => void;
  commitInlineEdit: () => void;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const normalizeMaybeText = (value: unknown) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const normalizeColumnKeyForIdHeuristic = (value: string) =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const isUuidLike = (value: unknown) => {
  const normalized = normalizeMaybeText(value);
  if (!normalized) return false;
  return UUID_PATTERN.test(normalized);
};

const isLikelyUuidColumnKey = (key: string) => {
  const normalized = normalizeColumnKeyForIdHeuristic(key);
  if (!normalized) return false;
  if (normalized === "id") return true;
  const tokens = normalized.split("_").filter(Boolean);
  const suffix = tokens[tokens.length - 1];
  return suffix === "id" || suffix === "uuid";
};

const shouldInferUuidEditType = ({
  configuredType,
  columnKey,
  value,
  resolvedItems,
}: {
  configuredType: InlineEditType;
  columnKey: string;
  value: unknown;
  resolvedItems: Record<string, unknown>[];
}) => {
  if (configuredType !== "text") return false;
  if (!isLikelyUuidColumnKey(columnKey)) return false;

  const normalizedValue = normalizeMaybeText(value);
  if (normalizedValue) {
    return UUID_PATTERN.test(normalizedValue);
  }

  let sawUuid = false;
  for (const item of resolvedItems) {
    const raw = item[columnKey];
    const normalized = normalizeMaybeText(raw);
    if (!normalized) continue;
    if (!UUID_PATTERN.test(normalized)) {
      return false;
    }
    sawUuid = true;
  }
  return sawUuid;
};

const parseDateValue = (value: unknown) => {
  if (value instanceof Date) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const formatDateInputValue = (value: unknown) => {
  const parsed = parseDateValue(value);
  if (!parsed) return "";
  return parsed.toISOString().slice(0, 10);
};

const formatDateTimeInputValue = (value: unknown) => {
  const parsed = parseDateValue(value);
  if (!parsed) return "";
  return parsed.toISOString().slice(0, 16);
};

const resolveInlineEditValue = (value: unknown, editType: InlineEditType): string | boolean | string[] => {
  if (editType === "boolean") return value === true;
  if (editType === "multiselect") {
    if (Array.isArray(value)) return value.map(String);
    if (value === null || value === undefined) return [];
    return [String(value)];
  }
  if (editType === "number") {
    return value === null || value === undefined ? "" : String(value);
  }
  if (editType === "date") return formatDateInputValue(value);
  if (editType === "datetime") return formatDateTimeInputValue(value);
  if (editType === "uuid") {
    return value === null || value === undefined ? "" : String(value);
  }
  if (editType === "select") {
    return value === null || value === undefined ? "" : String(value);
  }
  return value === null || value === undefined ? "" : String(value);
};

const normalizePatchValue = (value: string | boolean | string[], editType: InlineEditType) => {
  if (editType === "boolean") {
    if (typeof value === "boolean") return value;
    return value === "true";
  }
  if (editType === "multiselect") {
    if (Array.isArray(value)) return value.length > 0 ? value : null;
    return null;
  }
  if (editType === "number") {
    if (value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (editType === "uuid") {
    const normalized = String(value ?? "").trim().toLowerCase();
    return normalized ? normalized : null;
  }
  if (editType === "date" || editType === "datetime") {
    if (value === "") return null;
    return value;
  }
  if (editType === "select") {
    if (value === "") return null;
    return value;
  }
  return String(value);
};

const validateInlineEditValue = ({
  value,
  editType,
  label,
  t,
}: {
  value: string | boolean | string[];
  editType: InlineEditType;
  label: string;
  t: TranslateFn;
}) => {
  if (editType === "number") {
    const raw = String(value ?? "").trim();
    if (raw && !Number.isFinite(Number(raw))) {
      return t("edit.errors.invalidNumber", { label });
    }
  }
  if (editType === "uuid") {
    if (!isUuidLike(value) && String(value ?? "").trim()) {
      return t("edit.errors.invalidUuid", { label });
    }
  }
  return null;
};

const normalizeDbErrorCode = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (code === null || code === undefined) return null;
  const normalized = String(code).trim().toUpperCase();
  return normalized || null;
};

const normalizeDbErrorMessage = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  const typed = error as {
    message?: unknown;
    details?: unknown;
    hint?: unknown;
    error?: unknown;
  };
  const raw = typed.message ?? typed.details ?? typed.hint ?? typed.error;
  if (raw === null || raw === undefined) return null;
  const normalized = String(raw).trim().toLowerCase();
  return normalized || null;
};

const resolveInlineEditError = ({
  error,
  fallback,
  label,
  editType,
  t,
}: {
  error: unknown;
  fallback: string;
  label: string;
  editType: InlineEditType;
  t: TranslateFn;
}) => {
  const message = formatUiError(error, fallback);
  const normalizedMessage = message.trim().toLowerCase();
  const normalizedDbMessage = normalizeDbErrorMessage(error);
  const normalizedCode = normalizeDbErrorCode(error);

  const uuidSyntaxError =
    normalizedMessage.includes("invalid input syntax for type uuid") ||
    normalizedDbMessage?.includes("invalid input syntax for type uuid") === true ||
    (normalizedCode === "22P02" &&
      (editType === "uuid" ||
        normalizedMessage.includes("uuid") ||
        normalizedDbMessage?.includes("uuid") === true));
  if (uuidSyntaxError) {
    return t("edit.errors.invalidUuid", { label });
  }

  const numberSyntaxMarkers = [
    "invalid input syntax for type integer",
    "invalid input syntax for type bigint",
    "invalid input syntax for type smallint",
    "invalid input syntax for type numeric",
    "invalid input syntax for type real",
    "invalid input syntax for type double precision",
  ];
  const numberSyntaxError =
    numberSyntaxMarkers.some((marker) => normalizedMessage.includes(marker)) ||
    numberSyntaxMarkers.some(
      (marker) => normalizedDbMessage?.includes(marker) === true
    ) ||
    (normalizedCode === "22P02" && editType === "number");
  if (numberSyntaxError) {
    return t("edit.errors.invalidNumber", { label });
  }

  return message;
};

export function useInlineEdit({
  editConfigByKey,
  inlineEditEnabled,
  columnsByKey,
  resolvedResourceKey,
  resolvedItems,
  idKey,
  t,
  toast,
  startTransition,
  setRowOverrides,
}: InlineEditParams): InlineEditHandlers {
  const [inlineEdit, setInlineEdit] = React.useState<InlineEditState | null>(null);
  const optimisticSnapshotRef = React.useRef<Record<string, unknown> | null>(
    null
  );

  const startInlineEdit = React.useCallback(
    (rowId: string, column: ResourceColumn, value: unknown) => {
      const config = editConfigByKey.get(column.key);
      if (!config) return;
      const editType = shouldInferUuidEditType({
        configuredType: config.editType,
        columnKey: column.key,
        value,
        resolvedItems,
      })
        ? "uuid"
        : config.editType;
      setInlineEdit({
        rowId,
        columnKey: column.key,
        editType,
        value: resolveInlineEditValue(value, editType),
        status: "idle",
        error: null,
      });
    },
    [editConfigByKey, resolvedItems]
  );

  const updateInlineEditValue = React.useCallback((value: string | boolean | string[]) => {
    setInlineEdit((current) =>
      current
        ? {
            ...current,
            value,
            status: current.status === "error" ? "idle" : current.status,
            error: null,
          }
        : current
    );
  }, []);

  const cancelInlineEdit = React.useCallback(() => {
    setInlineEdit(null);
  }, []);

  const commitInlineEdit = React.useCallback(() => {
    if (!inlineEdit || !resolvedResourceKey || !inlineEditEnabled) return;
    if (inlineEdit.status === "saving") return;
    const columnLabel = columnsByKey.has(inlineEdit.columnKey)
      ? resolveColumnLabelByKey(columnsByKey, inlineEdit.columnKey)
      : inlineEdit.columnKey;
    const validationError = validateInlineEditValue({
      value: inlineEdit.value,
      editType: inlineEdit.editType,
      label: columnLabel,
      t,
    });
    if (validationError) {
      setInlineEdit((current) =>
        current
          ? {
              ...current,
              status: "error",
              error: validationError,
            }
          : current
      );
      toast({
        title: t("edit.error"),
        description: validationError,
        tone: "warning",
      });
      return;
    }
    const patchValue = normalizePatchValue(
      inlineEdit.value,
      inlineEdit.editType
    );
    const patch = { [inlineEdit.columnKey]: patchValue };
    optimisticSnapshotRef.current = applyOptimisticRowPatch({
      rowId: inlineEdit.rowId,
      patch,
      setRowOverrides,
    });
    setInlineEdit((current) =>
      current ? { ...current, status: "saving", error: null } : current
    );
    startTransition(async () => {
      try {
        const client = createUiClient();
        const result = await client.updateResource({
          resource: resolvedResourceKey,
          id: inlineEdit.rowId,
          patch,
        });
        const update =
          result && typeof result === "object"
            ? (result as Record<string, unknown>)
            : patch;
        setRowOverrides((current) => ({
          ...current,
          [inlineEdit.rowId]: {
            ...(current[inlineEdit.rowId] ?? {}),
            ...update,
          },
        }));
        optimisticSnapshotRef.current = null;
        toast({
          title: t("edit.success", { label: columnLabel }),
          tone: "success",
        });
        setInlineEdit(null);
      } catch (error) {
        rollbackOptimisticRowPatch({
          rowId: inlineEdit.rowId,
          snapshot: optimisticSnapshotRef.current,
          setRowOverrides,
        });
        optimisticSnapshotRef.current = null;
        const message = resolveInlineEditError({
          error,
          fallback: t("edit.error"),
          label: columnLabel,
          editType: inlineEdit.editType,
          t,
        });
        setInlineEdit((current) =>
          current
            ? {
                ...current,
                status: "error",
                error: message,
              }
            : current
        );
        toast({
          title: t("edit.error"),
          description: message,
          tone: "error",
        });
      }
    });
  }, [
    columnsByKey,
    inlineEdit,
    inlineEditEnabled,
    resolvedResourceKey,
    setRowOverrides,
    startTransition,
    t,
    toast,
  ]);

  React.useEffect(() => {
    if (!inlineEdit) return;
    if (!inlineEditEnabled) {
      setInlineEdit(null);
      return;
    }
    if (!editConfigByKey.has(inlineEdit.columnKey)) {
      setInlineEdit(null);
      return;
    }
    const exists = resolvedItems.some((item) => {
      if (!idKey) return false;
      const rawId = item[idKey];
      return rawId !== null && rawId !== undefined && String(rawId) === inlineEdit.rowId;
    });
    if (!exists) {
      setInlineEdit(null);
    }
  }, [inlineEdit, inlineEditEnabled, editConfigByKey, resolvedItems, idKey]);

  return {
    inlineEdit,
    startInlineEdit,
    updateInlineEditValue,
    cancelInlineEdit,
    commitInlineEdit,
  };
}
