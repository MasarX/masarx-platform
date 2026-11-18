"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { createUiClient } from "@masarx/api";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { createUiTranslator } from "./i18n";
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from "./modal";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { stripBasePath } from "./navigation-paths";
import { useToast } from "./use-toast";
import { formatUiError } from "./utils";
import { formatResourceValue } from "./resource-utils";
import { labelFromKey } from "./resource-query";
import {
  WorkflowTriggerContextPatchControls,
  parseWorkflowTriggerContextPatch,
  useWorkflowTriggerContextLookups,
} from "./workflow-trigger-context-patch-controls";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";

type WorkflowRunTriggersPanelProps = {
  workflowTemplateId: string;
  incomingTriggers: Record<string, unknown>[];
  outgoingTriggers: Record<string, unknown>[];
  workflowTemplates: Record<string, unknown>[];
  workflowRunStatusOptions?: WorkflowRunStatusOption[] | null;
  appBasePath: string;
  capabilities?: string[] | null;
  testIdPrefix?: string | null;
};

type TriggerDirection = "incoming" | "outgoing";

type EditorState = {
  open: boolean;
  mode: "create" | "edit";
  direction: TriggerDirection;
  triggerId: string | null;
  sourceWorkflowTemplateId: string;
  targetWorkflowTemplateId: string;
  sourceStatusesText: string;
  enabled: boolean;
  notes: string;
  contextPatchText: string;
  pending: boolean;
};

type DeleteState = {
  open: boolean;
  triggerId: string | null;
  pending: boolean;
};

type TemplateOption = {
  id: string;
  name: string;
};

type WorkflowRunStatusOption = { value: string; label: string };

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  return null;
}

function normalizeObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const resolved = value
    .map((entry) => (typeof entry === "string" ? entry : String(entry)))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(resolved));
}

function parseStatuses(text: string) {
  const parts = text
    .split(/[,\n]/g)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(parts));
  return unique.length > 0 ? unique : null;
}

function normalizeWorkflowRunStatusOptions(rows: unknown): WorkflowRunStatusOption[] {
  if (!Array.isArray(rows)) return [];
  const options: WorkflowRunStatusOption[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const payload = normalizeObject(row);
    const value = normalizeText(payload?.value ?? payload?.key ?? payload?.code);
    if (!value || seen.has(value)) continue;
    const label = normalizeText(payload?.label ?? payload?.name ?? payload?.description) ?? value;
    options.push({ value, label });
    seen.add(value);
  }
  return options.sort((left, right) => left.label.localeCompare(right.label));
}

function buildInitialEditor(direction: TriggerDirection): EditorState {
  return {
    open: false,
    mode: "create",
    direction,
    triggerId: null,
    sourceWorkflowTemplateId: "",
    targetWorkflowTemplateId: "",
    sourceStatusesText: "completed",
    enabled: true,
    notes: "",
    contextPatchText: "{}",
    pending: false,
  };
}

function buildInitialDelete(): DeleteState {
  return { open: false, triggerId: null, pending: false };
}

export function WorkflowRunTriggersPanel(props: WorkflowRunTriggersPanelProps) {
  const {
    workflowTemplateId,
    incomingTriggers,
    outgoingTriggers,
    workflowTemplates,
    workflowRunStatusOptions,
    appBasePath,
    capabilities,
    testIdPrefix,
  } = props;

  const t = createUiTranslator("ui.workflowStudio");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const safeBasePath = React.useMemo(() => resolveSafeAppBasePath(appBasePath), [appBasePath]);

  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const canWrite = hasCapability(capabilitySet, "workflow_runs.write");
  const canReadStatuses = canWrite || hasCapability(capabilitySet, "workflow_runs.read");

  const templates = React.useMemo(() => {
    const resolved: TemplateOption[] = [];
    workflowTemplates.forEach((row) => {
      const id = normalizeText(row.id);
      const name = normalizeText(row.name);
      if (!id || !name) return;
      resolved.push({ id, name });
    });
    resolved.sort((a, b) => a.name.localeCompare(b.name));
    return resolved;
  }, [workflowTemplates]);

  const templateById = React.useMemo(() => {
    const map = new Map<string, TemplateOption>();
    templates.forEach((entry) => map.set(entry.id, entry));
    return map;
  }, [templates]);

  const [incomingRows, setIncomingRows] = React.useState<Record<string, unknown>[]>(
    Array.isArray(incomingTriggers) ? incomingTriggers : []
  );
  const [outgoingRows, setOutgoingRows] = React.useState<Record<string, unknown>[]>(
    Array.isArray(outgoingTriggers) ? outgoingTriggers : []
  );
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<EditorState>(() =>
    buildInitialEditor("outgoing")
  );
  const [del, setDel] = React.useState<DeleteState>(() => buildInitialDelete());
  const statusId = React.useId();
  const [loadedStatuses, setLoadedStatuses] = React.useState<WorkflowRunStatusOption[]>([]);
  const statusOptions = workflowRunStatusOptions ?? loadedStatuses;
  const statusesByValue = new Map(statusOptions.map((option) => [option.value, option.label]));
  const selectedStatuses = parseStatuses(editor.sourceStatusesText) ?? [];
  const retainedStatuses = selectedStatuses.filter((value) => !statusesByValue.has(value));
  const lookupOptions = useWorkflowTriggerContextLookups(canWrite && editor.open);
  const contextPatchState = parseWorkflowTriggerContextPatch(
    editor.contextPatchText, t("triggers.workflowRuns.toast.invalidContextPatch")
  );

  React.useEffect(() => {
    if (!canReadStatuses || workflowRunStatusOptions != null) return;
    let cancelled = false;
    void Promise.resolve()
      .then(() => createUiClient().listLookupValues?.("workflow_run_status"))
      .then((rows) => {
        if (!cancelled) setLoadedStatuses(normalizeWorkflowRunStatusOptions(rows));
      })
      .catch(() => {
        if (!cancelled) setLoadedStatuses([]);
      });
    return () => { cancelled = true; };
  }, [canReadStatuses, workflowRunStatusOptions]);
  const safeHref = React.useCallback(
    (path: string) => (safeBasePath !== null ? resolveSafeHref(safeBasePath, path) : null),
    [safeBasePath]
  );

  React.useEffect(() => {
    setIncomingRows(Array.isArray(incomingTriggers) ? incomingTriggers : []);
  }, [incomingTriggers]);

  React.useEffect(() => {
    setOutgoingRows(Array.isArray(outgoingTriggers) ? outgoingTriggers : []);
  }, [outgoingTriggers]);

  const openIncomingHref = safeHref(
    `/resources/workflow_run_triggers?target_workflow_template_id=${encodeURIComponent(
      workflowTemplateId
    )}`
  );
  const openOutgoingHref = safeHref(
    `/resources/workflow_run_triggers?source_workflow_template_id=${encodeURIComponent(
      workflowTemplateId
    )}`
  );

  const availableOtherTemplates = templates.filter(
    (entry) => entry.id !== workflowTemplateId
  );
  const canCreateTrigger = canWrite && availableOtherTemplates.length > 0;

  return (
    <div className="space-y-4" data-testid={resolvedTestIdPrefix || undefined}>
      {renderSection({
        direction: "incoming",
        title: t("triggers.workflowRuns.incomingTitle"),
        description: t("triggers.workflowRuns.incomingDescription"),
        openHref: openIncomingHref,
        rows: incomingRows,
        emptyLabel: t("triggers.workflowRuns.incomingEmpty"),
        testId: resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-incoming` : undefined,
      })}

      {renderSection({
        direction: "outgoing",
        title: t("triggers.workflowRuns.outgoingTitle"),
        description: t("triggers.workflowRuns.outgoingDescription"),
        openHref: openOutgoingHref,
        rows: outgoingRows,
        emptyLabel: t("triggers.workflowRuns.outgoingEmpty"),
        testId: resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-outgoing` : undefined,
      })}

      <Modal
        open={editor.open}
        onOpenChange={(open) => {
          if (editor.pending) return;
          setEditor((current) => ({ ...current, open }));
        }}
      >
        <ModalContent data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor` : undefined}>
          <ModalHeader>
            <ModalTitle>
              {editor.mode === "create"
                ? t("triggers.workflowRuns.editor.createTitle")
                : t("triggers.workflowRuns.editor.editTitle")}
            </ModalTitle>
            <ModalDescription>
              {t("triggers.workflowRuns.editor.description")}
            </ModalDescription>
          </ModalHeader>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs font-medium text-ui-muted">
                  {t("triggers.workflowRuns.editor.fields.sourceTemplate")}
                </div>
                <Select
                  value={editor.sourceWorkflowTemplateId}
                  onChange={(event) =>
                    setEditor((current) => ({
                      ...current,
                      sourceWorkflowTemplateId: event.target.value,
                    }))
                  }
                  disabled={editor.pending}
                  data-testid={
                    resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-source-template` : undefined
                  }
                >
                  {editor.direction === "outgoing" ? (
                    <option value={workflowTemplateId}>
                      {templateById.get(workflowTemplateId)?.name ??
                        t("triggers.workflowRuns.editor.currentTemplate")}
                    </option>
                  ) : null}
                  {editor.direction === "incoming" ? (
                    <>
                      <option value="">
                        {t("triggers.workflowRuns.editor.pickTemplate")}
                      </option>
                      {availableOtherTemplates.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </>
                  ) : null}
                </Select>
              </div>

              <div className="space-y-1">
                <div className="text-xs font-medium text-ui-muted">
                  {t("triggers.workflowRuns.editor.fields.targetTemplate")}
                </div>
                <Select
                  value={editor.targetWorkflowTemplateId}
                  onChange={(event) =>
                    setEditor((current) => ({
                      ...current,
                      targetWorkflowTemplateId: event.target.value,
                    }))
                  }
                  disabled={editor.pending}
                  data-testid={
                    resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-target-template` : undefined
                  }
                >
                  {editor.direction === "incoming" ? (
                    <option value={workflowTemplateId}>
                      {templateById.get(workflowTemplateId)?.name ??
                        t("triggers.workflowRuns.editor.currentTemplate")}
                    </option>
                  ) : null}
                  {editor.direction === "outgoing" ? (
                    <>
                      <option value="">
                        {t("triggers.workflowRuns.editor.pickTemplate")}
                      </option>
                      {availableOtherTemplates.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </>
                  ) : null}
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor={statusId} className="text-xs font-medium text-ui-muted">
                {t("triggers.workflowRuns.editor.fields.statuses")}
              </label>
              {statusOptions.length > 0 ? (
                <Select
                  id={statusId}
                  multiple
                  value={selectedStatuses}
                  onChange={(event) => {
                    const chosen = Array.from(event.currentTarget.selectedOptions, (option) => option.value);
                    const ordered = [...selectedStatuses.filter((value) => chosen.includes(value)),
                      ...chosen.filter((value) => !selectedStatuses.includes(value))];
                    setEditor((current) => ({ ...current, sourceStatusesText: ordered.join(", ") }));
                  }}
                  disabled={editor.pending}
                  data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-statuses` : undefined}
                >
                  {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  {retainedStatuses.map((value) => <option key={value} value={value}>{labelFromKey(value)}</option>)}
                </Select>
              ) : (
                <Input
                  id={statusId}
                  value={editor.sourceStatusesText}
                  onChange={(event) =>
                    setEditor((current) => ({
                      ...current,
                      sourceStatusesText: event.target.value,
                    }))
                  }
                  placeholder={t("triggers.workflowRuns.editor.statusesPlaceholder")}
                  disabled={editor.pending}
                  data-testid={
                    resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-statuses` : undefined
                  }
                />
              )}
              <div className="text-xs text-ui-muted">
                {t("triggers.workflowRuns.editor.statusesHint")}
              </div>
            </div>

            <WorkflowTriggerContextPatchControls
              value={editor.contextPatchText}
              onChange={(contextPatchText) => setEditor((current) => ({ ...current, contextPatchText }))}
              lookupOptions={lookupOptions}
              disabled={editor.pending}
              label={t("triggers.workflowRuns.editor.fields.contextPatch")}
              hint={t("triggers.workflowRuns.editor.contextPatchHint")}
              invalidContextPatchMessage={t("triggers.workflowRuns.toast.invalidContextPatch")}
              formatLabel={t("triggers.workflowRuns.editor.formatJson")}
              resetLabel={t("triggers.workflowRuns.editor.reset")}
              lookupTestId={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-context-lookups` : undefined}
              textareaTestId={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-context-patch` : undefined}
              formatTestId={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-format-json` : undefined}
              resetTestId={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-reset-json` : undefined}
            />

            <label className="flex items-start gap-2 text-sm text-ui-ink">
              <input
                type="checkbox"
                className="mt-1"
                checked={editor.enabled}
                onChange={(event) =>
                  setEditor((current) => ({
                    ...current,
                    enabled: event.target.checked,
                  }))
                }
                disabled={editor.pending}
                data-testid={
                  resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-enabled` : undefined
                }
              />
              <span className="space-y-0.5">
                <span className="block">
                  {t("triggers.workflowRuns.editor.fields.enabled")}
                </span>
                <span className="block text-xs text-ui-muted">
                  {t("triggers.workflowRuns.editor.enabledHint")}
                </span>
              </span>
            </label>

            <div className="space-y-1">
              <div className="text-xs font-medium text-ui-muted">
                {t("triggers.workflowRuns.editor.fields.notes")}
              </div>
              <Input
                value={editor.notes}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder={t("triggers.workflowRuns.editor.notesPlaceholder")}
                disabled={editor.pending}
                data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-notes` : undefined}
              />
            </div>
          </div>

          <ModalFooter>
            <ModalClose asChild>
              <Button
                type="button"
                variant="ghost"
                disabled={editor.pending}
                data-testid={
                  resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-cancel` : undefined
                }
              >
                {t("triggers.workflowRuns.editor.cancel")}
              </Button>
            </ModalClose>
            <Button
              type="button"
              onClick={() => void submitEditor()}
              disabled={!canWrite || editor.pending}
              data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-save` : undefined}
            >
              {editor.pending
                ? t("triggers.workflowRuns.editor.submitting")
                : t("triggers.workflowRuns.editor.submit")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        open={del.open}
        onOpenChange={(open) => {
          if (del.pending) return;
          setDel((current) => ({ ...current, open }));
        }}
      >
        <ModalContent data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-delete` : undefined}>
          <ModalHeader>
            <ModalTitle>{t("triggers.workflowRuns.delete.title")}</ModalTitle>
            <ModalDescription>
              {t("triggers.workflowRuns.delete.description")}
            </ModalDescription>
          </ModalHeader>
          <ModalFooter>
            <ModalClose asChild>
              <Button
                type="button"
                variant="ghost"
                disabled={del.pending}
                data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-delete-cancel` : undefined}
              >
                {t("triggers.workflowRuns.delete.cancel")}
              </Button>
            </ModalClose>
            <Button
              type="button"
              variant="solid"
              className="bg-[rgb(var(--ui-danger))] text-[rgb(var(--ui-danger-ink))] shadow-sm hover:brightness-95"
              onClick={() => void confirmDelete()}
              disabled={!canWrite || del.pending}
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-delete-confirm` : undefined
              }
            >
              {del.pending
                ? t("triggers.workflowRuns.delete.deleting")
                : t("triggers.workflowRuns.delete.confirm")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );

  function renderSection(params: {
    direction: TriggerDirection;
    title: string;
    description: string;
    openHref: string | null;
    rows: Record<string, unknown>[];
    emptyLabel: string;
    testId?: string;
  }) {
    const { direction, title, description, openHref, rows, emptyLabel, testId } = params;
    const count = rows.length;

    return (
      <div className="space-y-3" data-testid={testId}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium text-ui-ink">{title}</h3>
              <span className="rounded-full border border-ui-border bg-ui-surface px-2 py-0.5 text-[10px] text-ui-muted">
                {count}
              </span>
            </div>
            <p className="text-xs text-ui-muted">{description}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {openHref ? (
              <a
                className="text-sm text-ui-ink underline underline-offset-4"
                href={openHref}
                data-testid={testId ? `${testId}-open-full` : undefined}
              >
                {t("triggers.workflowRuns.openFullView")}
              </a>
            ) : (
              <span className="text-sm text-ui-muted">
                {t("triggers.workflowRuns.openFullView")}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => openCreate(direction)}
              disabled={!canCreateTrigger || editor.pending || del.pending}
              data-testid={testId ? `${testId}-new` : undefined}
            >
              {t("triggers.workflowRuns.new")}
            </Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-3 text-sm text-ui-muted">
            {emptyLabel}
          </div>
        ) : (
          <div className="space-y-2">{rows.map((row) => renderRow(row))}</div>
        )}
      </div>
    );
  }

  function renderRow(row: Record<string, unknown>) {
    const triggerId = normalizeText(row.id);
    if (!triggerId) return null;

    const enabled = normalizeBoolean(row.enabled) ?? false;
    const sourceTemplateId = normalizeText(row.source_workflow_template_id);
    const targetTemplateId = normalizeText(row.target_workflow_template_id);
    const sourceTemplate = sourceTemplateId ? templateById.get(sourceTemplateId) : null;
    const targetTemplate = targetTemplateId ? templateById.get(targetTemplateId) : null;

    const statuses = normalizeStringArray(row.source_statuses);
    const statusesSummary = (statuses.length ? statuses : ["completed"])
      .map((value) => statusesByValue.get(value) ?? labelFromKey(value)).join(", ");
    const createdAt = formatResourceValue(row.created_at, { renderType: "datetime" });
    const updatedAt = formatResourceValue(row.updated_at, { renderType: "datetime" });

    const firesHref = safeHref(
      `/resources/workflow_trigger_fires?workflow_run_trigger_id=${encodeURIComponent(
        triggerId
      )}`
    );
    const sourceTemplateHref = sourceTemplateId
      ? safeHref(
          `/workflows/templates/${encodeURIComponent(sourceTemplateId)}`
        )
      : null;
    const targetTemplateHref = targetTemplateId
      ? safeHref(
          `/workflows/templates/${encodeURIComponent(targetTemplateId)}`
        )
      : null;

    const isBusy = busyId === triggerId || editor.pending || del.pending;

    return (
      <div
        key={triggerId}
        className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-ui-border bg-ui-surface/70 px-3 py-2 text-sm"
        data-testid={
          resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-row-${triggerId}` : undefined
        }
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate font-medium text-ui-ink">
              {t("triggers.workflowRuns.row.summary", {
                source: sourceTemplate?.name ?? sourceTemplateId ?? "?",
                target: targetTemplate?.name ?? targetTemplateId ?? "?",
              })}
            </div>
            <span className="rounded-full border border-ui-border bg-ui-paper/60 px-2 py-0.5 text-[10px] text-ui-muted">
              {enabled
                ? t("triggers.workflowRuns.row.enabled")
                : t("triggers.workflowRuns.row.disabled")}
            </span>
          </div>
          <div className="text-xs text-ui-muted">
            {t("triggers.workflowRuns.row.statuses", { value: statusesSummary })}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
            <span>{t("triggers.workflowRuns.row.created", { value: createdAt })}</span>
            <span>{t("triggers.workflowRuns.row.updated", { value: updatedAt })}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {firesHref ? (
              <a
                className="text-ui-ink underline underline-offset-4"
                href={firesHref}
              >
                {t("triggers.workflowRuns.row.openFires")}
              </a>
            ) : (
              <span className="text-ui-muted">
                {t("triggers.workflowRuns.row.openFires")}
              </span>
            )}
            {sourceTemplateId ? (
              sourceTemplateHref ? (
                <button
                  type="button"
                  className="text-ui-ink underline underline-offset-4"
                  onClick={() => {
                    router.push(stripBasePath(sourceTemplateHref, safeBasePath ?? ""));
                  }}
                >
                  {t("triggers.workflowRuns.row.openSource")}
                </button>
              ) : (
                <span className="text-ui-muted">
                  {t("triggers.workflowRuns.row.openSource")}
                </span>
              )
            ) : null}
            {targetTemplateId ? (
              targetTemplateHref ? (
                <button
                  type="button"
                  className="text-ui-ink underline underline-offset-4"
                  onClick={() => {
                    router.push(stripBasePath(targetTemplateHref, safeBasePath ?? ""));
                  }}
                >
                  {t("triggers.workflowRuns.row.openTarget")}
                </button>
              ) : (
                <span className="text-ui-muted">
                  {t("triggers.workflowRuns.row.openTarget")}
                </span>
              )
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void handleToggleEnabled(row)}
            disabled={!canWrite || isBusy}
            data-testid={
              resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-row-${triggerId}-toggle` : undefined
            }
          >
            {enabled ? t("triggers.workflowRuns.row.disable") : t("triggers.workflowRuns.row.enable")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => openEdit(row)}
            disabled={!canWrite || isBusy}
            data-testid={
              resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-row-${triggerId}-edit` : undefined
            }
          >
            {t("triggers.workflowRuns.row.edit")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setDel({ open: true, triggerId, pending: false })}
            disabled={!canWrite || isBusy}
            data-testid={
              resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-row-${triggerId}-delete` : undefined
            }
          >
            {t("triggers.workflowRuns.row.delete")}
          </Button>
        </div>
      </div>
    );
  }

  function openCreate(direction: TriggerDirection) {
    if (!canCreateTrigger || editor.pending || del.pending) return;
    const next = buildInitialEditor(direction);

    if (direction === "outgoing") {
      next.sourceWorkflowTemplateId = workflowTemplateId;
      next.targetWorkflowTemplateId = availableOtherTemplates[0]?.id ?? "";
    } else {
      next.targetWorkflowTemplateId = workflowTemplateId;
      next.sourceWorkflowTemplateId = availableOtherTemplates[0]?.id ?? "";
    }

    setEditor({ ...next, open: true });
  }

  function openEdit(row: Record<string, unknown>) {
    if (!canWrite || editor.pending || del.pending) return;
    const triggerId = normalizeText(row.id);
    if (!triggerId) return;
    const sourceTemplateId = normalizeText(row.source_workflow_template_id) ?? "";
    const targetTemplateId = normalizeText(row.target_workflow_template_id) ?? "";
    const statuses = normalizeStringArray(row.source_statuses);
    const contextPatch = normalizeObject(row.context_patch) ?? {};

    const direction: TriggerDirection =
      targetTemplateId === workflowTemplateId ? "incoming" : "outgoing";

    setEditor({
      open: true,
      mode: "edit",
      direction,
      triggerId,
      sourceWorkflowTemplateId: sourceTemplateId,
      targetWorkflowTemplateId: targetTemplateId,
      sourceStatusesText: statuses.length > 0 ? statuses.join(", ") : "completed",
      enabled: normalizeBoolean(row.enabled) ?? true,
      notes: normalizeText(row.notes) ?? "",
      contextPatchText: JSON.stringify(contextPatch, null, 2),
      pending: false,
    });
  }

  function upsertWorkflowRunRow(
    direction: TriggerDirection,
    triggerId: string,
    row: Record<string, unknown>
  ) {
    const withId = { ...row, id: normalizeText(row.id) ?? triggerId };
    if (direction === "incoming") {
      setIncomingRows((current) => {
        const filtered = current.filter((entry) => normalizeText(entry.id) !== triggerId);
        return [...filtered, withId];
      });
      setOutgoingRows((current) =>
        current.filter((entry) => normalizeText(entry.id) !== triggerId)
      );
      return;
    }

    setOutgoingRows((current) => {
      const filtered = current.filter((entry) => normalizeText(entry.id) !== triggerId);
      return [...filtered, withId];
    });
    setIncomingRows((current) =>
      current.filter((entry) => normalizeText(entry.id) !== triggerId)
    );
  }

  function removeWorkflowRunRow(triggerId: string) {
    setIncomingRows((current) =>
      current.filter((entry) => normalizeText(entry.id) !== triggerId)
    );
    setOutgoingRows((current) =>
      current.filter((entry) => normalizeText(entry.id) !== triggerId)
    );
  }

  async function handleToggleEnabled(row: Record<string, unknown>) {
    if (!canWrite || busyId || editor.pending || del.pending) return;
    const triggerId = normalizeText(row.id);
    if (!triggerId) return;
    const nextEnabled = !(normalizeBoolean(row.enabled) ?? true);
    setBusyId(triggerId);
    try {
      const ui = createUiClient();
      const updated = await ui.updateWorkflowRunTrigger({
        workflowRunTriggerId: triggerId,
        enabled: nextEnabled,
      });
      if (updated?.workflow_run_trigger_id !== triggerId) {
        throw new Error(t("triggers.workflowRuns.toast.updateErrorTitle"));
      }
      const updatedRow = { ...row, ...updated, id: triggerId };

      setIncomingRows((current) =>
        current.map((entry) => (normalizeText(entry.id) === triggerId ? updatedRow : entry))
      );
      setOutgoingRows((current) =>
        current.map((entry) => (normalizeText(entry.id) === triggerId ? updatedRow : entry))
      );

      toast({
        tone: "success",
        title: nextEnabled
          ? t("triggers.workflowRuns.toast.enabled")
          : t("triggers.workflowRuns.toast.disabled"),
      });
    } catch (error) {
      toast({
        tone: "error",
        title: t("triggers.workflowRuns.toast.updateErrorTitle"),
        description: formatUiError(error, t("triggers.workflowRuns.toast.updateErrorTitle")),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function submitEditor() {
    if (!canWrite || editor.pending || del.pending) return;
    setEditor((current) => ({ ...current, pending: true }));

    try {
      const sourceTemplateId = editor.sourceWorkflowTemplateId.trim();
      const targetTemplateId = editor.targetWorkflowTemplateId.trim();

      if (!sourceTemplateId || !targetTemplateId) {
        throw new Error(t("triggers.workflowRuns.toast.missingTemplate"));
      }
      if (sourceTemplateId === targetTemplateId) {
        throw new Error(t("triggers.workflowRuns.toast.sameTemplate"));
      }

      const statuses = parseStatuses(editor.sourceStatusesText) ?? (statusOptions.length ? [] : ["completed"]);
      if (statuses.length === 0) {
        throw new Error(t("triggers.workflowRuns.toast.invalidStatuses"));
      }

      const contextPatch = contextPatchState.value;
      if (!contextPatch) {
        throw new Error(t("triggers.workflowRuns.toast.invalidContextPatch"));
      }

      const ui = createUiClient();
      if (editor.mode === "create") {
        const created = await ui.createWorkflowRunTrigger({
          sourceWorkflowTemplateId: sourceTemplateId,
          targetWorkflowTemplateId: targetTemplateId,
          sourceStatuses: statuses,
          contextPatch,
          enabled: editor.enabled,
          notes: editor.notes.trim() || null,
        });
        const triggerId = created?.workflow_run_trigger_id?.trim?.() ?? "";
        if (!triggerId) {
          toast({
            tone: "error",
            title: t("triggers.workflowRuns.toast.createErrorTitle"),
            description: t("triggers.workflowRuns.toast.createErrorMissingId"),
          });
          return;
        }
        const createdRow =
          created && typeof created === "object" ? (created as Record<string, unknown>) : {};
        const nextRow: Record<string, unknown> = {
          source_workflow_template_id: sourceTemplateId,
          target_workflow_template_id: targetTemplateId,
          source_statuses: statuses,
          enabled: editor.enabled,
          notes: editor.notes.trim() || null,
          context_patch: contextPatch,
          ...createdRow,
          id: triggerId,
        };
        const direction: TriggerDirection =
          targetTemplateId === workflowTemplateId ? "incoming" : "outgoing";
        upsertWorkflowRunRow(direction, triggerId, nextRow);
        toast({ tone: "success", title: t("triggers.workflowRuns.toast.created") });
      } else if (editor.triggerId) {
        const updated = await ui.updateWorkflowRunTrigger({
          workflowRunTriggerId: editor.triggerId,
          sourceWorkflowTemplateId: sourceTemplateId,
          targetWorkflowTemplateId: targetTemplateId,
          sourceStatuses: statuses,
          contextPatch,
          enabled: editor.enabled,
          notes: editor.notes.trim(),
        });
        if (updated?.workflow_run_trigger_id !== editor.triggerId) {
          throw new Error(t("triggers.workflowRuns.toast.updateErrorTitle"));
        }
        const previous = [...incomingRows, ...outgoingRows].find(
          (row) => normalizeText(row.id) === editor.triggerId
        );
        const nextRow = { ...previous, ...updated, id: editor.triggerId };
        const direction: TriggerDirection =
          targetTemplateId === workflowTemplateId ? "incoming" : "outgoing";
        upsertWorkflowRunRow(direction, editor.triggerId, nextRow);
        toast({ tone: "success", title: t("triggers.workflowRuns.toast.updated") });
      }

      setEditor(buildInitialEditor("outgoing"));
      queryClient.invalidateQueries({ queryKey: ["resource"] });
    } catch (error) {
      const fallbackTitle =
        editor.mode === "create"
          ? t("triggers.workflowRuns.toast.createErrorTitle")
          : t("triggers.workflowRuns.toast.updateErrorTitle");
      toast({
        tone: "error",
        title: fallbackTitle,
        description: formatUiError(error, fallbackTitle),
      });
    } finally {
      setEditor((current) => ({ ...current, pending: false }));
    }
  }

  async function confirmDelete() {
    if (!canWrite || del.pending || !del.triggerId || editor.pending) return;
    setDel((current) => ({ ...current, pending: true }));
    try {
      const ui = createUiClient();
      const deleted = await ui.deleteWorkflowRunTrigger(del.triggerId);
      if (deleted?.workflow_run_trigger_id !== del.triggerId) {
        throw new Error(t("triggers.workflowRuns.toast.deleteErrorTitle"));
      }
      toast({ tone: "success", title: t("triggers.workflowRuns.toast.deleted") });
      removeWorkflowRunRow(del.triggerId);
      setDel(buildInitialDelete());
      queryClient.invalidateQueries({ queryKey: ["resource"] });
    } catch (error) {
      toast({
        tone: "error",
        title: t("triggers.workflowRuns.toast.deleteErrorTitle"),
        description: formatUiError(error, t("triggers.workflowRuns.toast.deleteErrorTitle")),
      });
      setDel((current) => ({ ...current, pending: false }));
    }
  }
}
