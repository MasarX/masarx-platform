"use client";

import * as React from "react";
import {
  WorkflowTriggerContextPatchControls,
  parseWorkflowTriggerContextPatch,
  useWorkflowTriggerContextLookups,
} from "./workflow-trigger-context-patch-controls";
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
import { navigateTo } from "./navigate";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { useToast } from "./use-toast";
import { formatUiError, UiMessageError } from "./utils";
import { formatResourceValue } from "./resource-utils";
import { resolveWorkflowRunDestination } from "./workflow-run-navigation";
import type { WorkflowScheduleTemplateGuide } from "./workflow-schedule-template-guide";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";

type WorkflowScheduleTriggersPanelProps = {
  workflowTemplateId: string;
  triggers: Record<string, unknown>[];
  triggersTotal?: number | null;
  appBasePath: string;
  templateStatus?: string | null;
  scheduleTemplateGuide?: WorkflowScheduleTemplateGuide | null;
  capabilities?: string[] | null;
  testIdPrefix?: string | null;
};

type ScheduleType = "interval" | "daily" | "weekly";
type IntervalUnit = "seconds" | "minutes" | "hours";

type EditorState = {
  open: boolean;
  mode: "create" | "edit";
  triggerId: string | null;
  scheduleType: ScheduleType;
  timezone: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  dailyTime: string;
  weeklyDays: string[];
  weeklyTime: string;
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

function resolveTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

function parseTimeInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function toTimeInputValue(hour: number, minute: number) {
  const hh = String(Math.max(0, Math.min(23, hour))).padStart(2, "0");
  const mm = String(Math.max(0, Math.min(59, minute))).padStart(2, "0");
  return `${hh}:${mm}`;
}

function resolveScheduleType(schedule: Record<string, unknown> | null): ScheduleType {
  const raw = normalizeText(schedule?.type)?.toLowerCase();
  if (raw === "daily") return "daily";
  if (raw === "weekly") return "weekly";
  return "interval";
}

function resolveScheduleIntervalSeconds(schedule: Record<string, unknown> | null) {
  const secondsRaw =
    typeof schedule?.interval_seconds === "number"
      ? schedule.interval_seconds
      : typeof schedule?.every_seconds === "number"
        ? schedule.every_seconds
        : Number(schedule?.interval_seconds ?? schedule?.every_seconds);
  const seconds = Number.isFinite(secondsRaw) && secondsRaw > 0 ? Math.trunc(secondsRaw) : null;
  return seconds;
}

function resolveScheduleAtTime(schedule: Record<string, unknown> | null) {
  const atTime = normalizeText(schedule?.at_time);
  if (atTime) return atTime;
  const hour = typeof schedule?.hour === "number" ? schedule.hour : Number(schedule?.hour);
  const minute = typeof schedule?.minute === "number" ? schedule.minute : Number(schedule?.minute);
  if (Number.isFinite(hour) && Number.isFinite(minute)) return toTimeInputValue(hour, minute);
  return null;
}

function resolveScheduleWeekdays(schedule: Record<string, unknown> | null) {
  const rawDays = schedule?.days_of_week;
  const resolved: number[] = [];

  if (Array.isArray(rawDays)) {
    rawDays.forEach((value) => {
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed)) return;
      const normalized = Math.trunc(parsed);
      if (normalized < 0 || normalized > 6) return;
      if (!resolved.includes(normalized)) resolved.push(normalized);
    });
  } else {
    const legacyWeekday =
      typeof schedule?.weekday === "number" ? schedule.weekday : Number(schedule?.weekday);
    if (Number.isFinite(legacyWeekday)) {
      const normalized = Math.trunc(legacyWeekday);
      if (normalized >= 0 && normalized <= 6) resolved.push(normalized);
    }
  }

  resolved.sort((a, b) => a - b);
  return resolved;
}

function buildScheduleSummary(
  t: ReturnType<typeof createUiTranslator>,
  schedule: Record<string, unknown> | null
) {
  const scheduleType = resolveScheduleType(schedule);
  const timezone = normalizeText(schedule?.timezone) ?? t("triggers.schedules.timezoneDefault");

  if (scheduleType === "daily") {
    const atTime = resolveScheduleAtTime(schedule);
    const parsed = atTime ? parseTimeInput(atTime) : null;
    const at = parsed ? toTimeInputValue(parsed.hour, parsed.minute) : t("triggers.schedules.unknownTime");
    return { title: t("triggers.schedules.type.daily"), detail: `${at} · ${timezone}` };
  }

  if (scheduleType === "weekly") {
    const atTime = resolveScheduleAtTime(schedule);
    const parsed = atTime ? parseTimeInput(atTime) : null;
    const at = parsed ? toTimeInputValue(parsed.hour, parsed.minute) : t("triggers.schedules.unknownTime");

    const weekdays = resolveScheduleWeekdays(schedule);
    const weekdayLabel =
      weekdays.length === 0
        ? t("triggers.schedules.weekdays.unknown")
        : weekdays
            .slice(0, 3)
            .map((weekday) => t(`triggers.schedules.weekdays.${String(weekday)}`))
            .join(", ") + (weekdays.length > 3 ? ` +${weekdays.length - 3}` : "");
    return {
      title: t("triggers.schedules.type.weekly"),
      detail: `${weekdayLabel} · ${at} · ${timezone}`,
    };
  }

  const seconds = resolveScheduleIntervalSeconds(schedule);
  if (!seconds) return { title: t("triggers.schedules.type.interval"), detail: timezone };
  if (seconds % 3600 === 0) {
    return {
      title: t("triggers.schedules.type.interval"),
      detail: t("triggers.schedules.intervalHours", {
        count: seconds / 3600,
        timezone,
      }),
    };
  }
  if (seconds % 60 === 0) {
    return {
      title: t("triggers.schedules.type.interval"),
      detail: t("triggers.schedules.intervalMinutes", {
        count: seconds / 60,
        timezone,
      }),
    };
  }
  return {
    title: t("triggers.schedules.type.interval"),
    detail: t("triggers.schedules.intervalSeconds", { count: seconds, timezone }),
  };
}

function buildInitialEditor(): EditorState {
  return {
    open: false,
    mode: "create",
    triggerId: null,
    scheduleType: "interval",
    timezone: resolveTimeZone(),
    intervalValue: "1",
    intervalUnit: "hours",
    dailyTime: "09:00",
    weeklyDays: ["1"],
    weeklyTime: "09:00",
    enabled: true,
    notes: "",
    contextPatchText: "{}",
    pending: false,
  };
}

function buildInitialDelete(): DeleteState {
  return { open: false, triggerId: null, pending: false };
}

export function WorkflowScheduleTriggersPanel({
  workflowTemplateId,
  triggers,
  triggersTotal,
  appBasePath,
  templateStatus,
  scheduleTemplateGuide,
  capabilities,
  testIdPrefix,
}: WorkflowScheduleTriggersPanelProps) {
  const t = createUiTranslator("ui.workflowStudio");
  const readbackT = createUiTranslator("ui.resourceActions");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const canWrite = hasCapability(capabilitySet, "workflow_runs.write");
  const resolvedTemplateStatus = normalizeText(templateStatus)?.toLowerCase() ?? null;
  const templateStatusKnown = resolvedTemplateStatus !== null;
  const templateIsActive = resolvedTemplateStatus === "active";
  const canRunNow = canWrite && (!templateStatusKnown || templateIsActive);
  const safeBasePath = React.useMemo(() => resolveSafeAppBasePath(appBasePath), [appBasePath]);

  const [rows, setRows] = React.useState<Record<string, unknown>[]>(() => triggers);
  React.useEffect(() => {
    setRows(triggers);
  }, [triggers]);

  const [editor, setEditor] = React.useState<EditorState>(() => buildInitialEditor());
  const [del, setDel] = React.useState<DeleteState>(() => buildInitialDelete());
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [runReceipts, setRunReceipts] = React.useState<Record<string, string>>({});
  const safeHref = React.useCallback(
    (path: string) => (safeBasePath !== null ? resolveSafeHref(safeBasePath, path) : null),
    [safeBasePath]
  );

  const lookupOptions = useWorkflowTriggerContextLookups(canWrite && editor.open);
  const contextPatchState = parseWorkflowTriggerContextPatch(
    editor.contextPatchText, t("triggers.schedules.toast.invalidContextPatch")
  );

  const schedulePreview = React.useMemo(() => {
    const timezone = editor.timezone.trim() || resolveTimeZone();

    if (editor.scheduleType === "daily") {
      const parsed = parseTimeInput(editor.dailyTime);
      if (!parsed) return null;
      return {
        type: "daily",
        at_time: toTimeInputValue(parsed.hour, parsed.minute),
        timezone,
      };
    }

    if (editor.scheduleType === "weekly") {
      const parsed = parseTimeInput(editor.weeklyTime);
      if (!parsed) return null;
      const selected = editor.weeklyDays
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.trunc(value))
        .filter((value) => value >= 0 && value <= 6);
      const unique = Array.from(new Set(selected)).sort((a, b) => a - b);
      if (unique.length === 0) return null;
      return {
        type: "weekly",
        days_of_week: unique,
        at_time: toTimeInputValue(parsed.hour, parsed.minute),
        timezone,
      };
    }

    const value = Number(editor.intervalValue);
    if (!Number.isFinite(value) || value <= 0) return null;
    const multiplier =
      editor.intervalUnit === "hours"
        ? 3600
        : editor.intervalUnit === "minutes"
          ? 60
          : 1;
    const seconds = Math.trunc(value * multiplier);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;

    return {
      type: "interval",
      interval_seconds: seconds,
      timezone,
    };
  }, [
    editor.dailyTime,
    editor.intervalUnit,
    editor.intervalValue,
    editor.scheduleType,
    editor.timezone,
    editor.weeklyDays,
    editor.weeklyTime,
  ]);

  const schedulePreviewSummary = React.useMemo(() => {
    return schedulePreview ? buildScheduleSummary(t, schedulePreview) : null;
  }, [schedulePreview, t]);

  const canSubmitEditor = Boolean(
    canWrite && schedulePreview && !contextPatchState.error && !editor.pending && !del.pending
  );
  const scheduleGuideExample = React.useMemo(
    () =>
      scheduleTemplateGuide
        ? JSON.stringify(scheduleTemplateGuide.exampleContextPatch, null, 2)
        : null,
    [scheduleTemplateGuide]
  );

  const totalCount =
    typeof triggersTotal === "number" ? triggersTotal : rows.length;

  const fullViewHref = safeHref(
    `/resources/workflow_schedule_triggers?workflow_template_id=${encodeURIComponent(
      workflowTemplateId
    )}`
  );

  return (
    <div className="space-y-3" data-testid={resolvedTestIdPrefix || undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-ui-ink">
              {t("triggers.schedules.title")}
            </h3>
            <span className="rounded-full border border-ui-border bg-ui-surface px-2 py-0.5 text-[10px] text-ui-muted">
              {totalCount}
            </span>
          </div>
          <p className="text-xs text-ui-muted">{t("triggers.schedules.description")}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {fullViewHref ? (
            <a
              className="text-sm text-ui-ink underline underline-offset-4"
              href={fullViewHref}
            >
              {t("triggers.schedules.openFullView")}
            </a>
          ) : (
            <span className="text-sm text-ui-muted">
              {t("triggers.schedules.openFullView")}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => setEditor({ ...buildInitialEditor(), open: true })}
            disabled={!canWrite}
            data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-new` : undefined}
          >
            {t("triggers.schedules.new")}
          </Button>
        </div>
      </div>

      <div className="text-xs text-ui-muted">
        {t("triggers.schedules.count", { count: String(totalCount) })}
      </div>

      {templateStatusKnown && !templateIsActive ? (
        <div className="rounded-xl border border-ui-border bg-ui-paper/60 p-3 text-xs text-ui-muted">
          {t("actions.testRunModal.templateNotActive")}
        </div>
      ) : null}

      {scheduleTemplateGuide ? (
        <div
          className="space-y-2 rounded-xl border border-ui-border bg-ui-paper/60 p-3"
          data-testid={
            resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-shipment-guide` : undefined
          }
        >
          <div className="space-y-1">
            <p className="text-sm font-medium text-ui-ink">
              {t("triggers.schedules.shipmentGuide.title")}
            </p>
            <p className="text-xs text-ui-muted">
              {scheduleTemplateGuide.kind === "shipment_create_reserved"
                ? t("triggers.schedules.shipmentGuide.reserveDescription")
                : t("triggers.schedules.shipmentGuide.directCreateDescription")}
            </p>
            <p className="text-xs text-ui-muted/80">
              {t("triggers.schedules.shipmentGuide.scopeHint")}
            </p>
          </div>
          {scheduleGuideExample ? (
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ui-muted">
                {t("triggers.schedules.shipmentGuide.exampleLabel")}
              </p>
              <pre
                className="overflow-x-auto rounded-lg bg-ui-surface px-3 py-2 font-mono text-[11px] text-ui-ink"
                data-testid={
                  resolvedTestIdPrefix
                    ? `${resolvedTestIdPrefix}-shipment-guide-example`
                    : undefined
                }
              >
                {scheduleGuideExample}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-3 text-sm text-ui-muted">
          {t("triggers.schedules.empty")}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const triggerId = normalizeText(row.id);
            if (!triggerId) return null;
            const enabled = normalizeBoolean(row.enabled) ?? false;
            const schedule = normalizeObject(row.schedule);
            const summary = buildScheduleSummary(t, schedule);
            const nextRun = formatResourceValue(row.next_run_at, { renderType: "datetime" });
            const lastRun = row.last_run_at
              ? formatResourceValue(row.last_run_at, { renderType: "datetime" })
              : null;
            const runReceiptId = runReceipts[triggerId];
            const runReceiptHref = runReceiptId
              ? safeHref(`/workflows/runs/${encodeURIComponent(runReceiptId)}`)
              : null;
            const lastRunId = runReceiptId ?? normalizeText(row.last_run_id);
            const lastError = normalizeText(row.last_error);
            const notes = normalizeText(row.notes);
            const isBusy = busyId === triggerId || editor.pending;

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
                    <div className="truncate font-medium text-ui-ink">{summary.title}</div>
                    <span className="rounded-full border border-ui-border bg-ui-paper/60 px-2 py-0.5 text-[10px] text-ui-muted">
                      {enabled
                        ? t("triggers.schedules.enabled")
                        : t("triggers.schedules.disabled")}
                    </span>
                  </div>
                  <div className="text-xs text-ui-muted">{summary.detail}</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ui-muted">
                    <span>{t("triggers.schedules.nextRun", { value: nextRun })}</span>
                    {lastRun ? (
                      <span>{t("triggers.schedules.lastRun", { value: lastRun })}</span>
                    ) : null}
                    {lastError ? (
                      <span className="text-ui-danger">
                        {t("triggers.schedules.lastError", { value: lastError })}
                      </span>
                    ) : null}
                  </div>
                  {notes ? <div className="text-xs text-ui-muted/80">{notes}</div> : null}
                  {runReceiptId ? (
                    <div role="status" className="text-xs text-ui-muted"
                      data-testid={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-run-readback-${triggerId}` : undefined}>
                      <span>{t("triggers.schedules.toast.runStarted")}</span>{" "}
                      <span>{runReceiptId}</span>
                      {runReceiptHref ? (
                        <a className="ml-2 underline underline-offset-4"
                          href={runReceiptHref}>
                          {t("triggers.schedules.openLastRun")}
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                  {(() => {
                    const safeLastRunHref = !runReceiptId && lastRunId
                      ? safeHref(
                          `/workflows/runs/${encodeURIComponent(lastRunId)}`
                        )
                      : null;
                    return safeLastRunHref ? (
                      <a
                        className="text-xs text-ui-ink underline underline-offset-4"
                        href={safeLastRunHref}
                      >
                        {t("triggers.schedules.openLastRun")}
                      </a>
                    ) : null;
                  })()}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRunNow(row)}
                    disabled={!canRunNow || isBusy}
                    data-testid={
                      resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-run-${triggerId}` : undefined
                    }
                  >
                    {t("triggers.schedules.runNow")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleToggleEnabled(row)}
                    disabled={!canWrite || isBusy}
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-toggle-${triggerId}`
                        : undefined
                    }
                  >
                    {enabled ? t("triggers.schedules.disable") : t("triggers.schedules.enable")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => openEdit(row)}
                    disabled={!canWrite || isBusy}
                    data-testid={
                      resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-edit-${triggerId}` : undefined
                    }
                  >
                    {t("triggers.schedules.edit")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => requestDelete(row)}
                    disabled={!canWrite || isBusy}
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-delete-${triggerId}`
                        : undefined
                    }
                  >
                    {t("triggers.schedules.delete")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal
        open={editor.open}
        onOpenChange={(nextOpen) => {
          if (editor.pending && !nextOpen) return;
          if (!nextOpen) {
            setEditor(buildInitialEditor());
            return;
          }
          setEditor((current) => ({ ...current, open: true }));
        }}
      >
        <ModalContent
          data-testid={
            resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-modal` : undefined
          }
        >
          <ModalHeader>
            <ModalTitle>
              {editor.mode === "create"
                ? t("triggers.schedules.create.title")
                : t("triggers.schedules.editTitle")}
            </ModalTitle>
            <ModalDescription>{t("triggers.schedules.create.description")}</ModalDescription>
          </ModalHeader>

          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-medium text-ui-muted">
                  {t("triggers.schedules.fields.type")}
                </label>
                <Select
                  value={editor.scheduleType}
                  onChange={(event) =>
                    setEditor((current) => ({
                      ...current,
                      scheduleType: event.target.value as ScheduleType,
                    }))
                  }
                  disabled={editor.pending}
                  data-testid={
                    resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-type` : undefined
                  }
                >
                  <option value="interval">{t("triggers.schedules.type.interval")}</option>
                  <option value="daily">{t("triggers.schedules.type.daily")}</option>
                  <option value="weekly">{t("triggers.schedules.type.weekly")}</option>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-ui-muted">
                  {t("triggers.schedules.fields.timezone")}
                </label>
                <Input
                  value={editor.timezone}
                  onChange={(event) =>
                    setEditor((current) => ({ ...current, timezone: event.target.value }))
                  }
                  placeholder="UTC"
                  disabled={editor.pending}
                  data-testid={
                    resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-timezone` : undefined
                  }
                />
              </div>
            </div>

            {schedulePreviewSummary ? (
              <div className="rounded-xl border border-ui-border bg-ui-paper/60 p-3">
                <div className="text-xs font-medium text-ui-ink">
                  {schedulePreviewSummary.title}
                </div>
                <div className="mt-1 text-xs text-ui-muted">
                  {schedulePreviewSummary.detail}
                </div>
              </div>
            ) : null}

            {editor.scheduleType === "interval" ? (
              <div className="space-y-2">
                <label className="text-xs font-medium text-ui-muted">
                  {t("triggers.schedules.fields.intervalSeconds")}
                </label>
                <div className="grid gap-2 sm:grid-cols-[1fr,160px]">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={editor.intervalValue}
                    onChange={(event) =>
                      setEditor((current) => ({
                        ...current,
                        intervalValue: event.target.value,
                      }))
                    }
                    disabled={editor.pending}
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-editor-interval-value`
                        : undefined
                    }
                  />
                  <Select
                    value={editor.intervalUnit}
                    onChange={(event) =>
                      setEditor((current) => ({
                        ...current,
                        intervalUnit: event.target.value as IntervalUnit,
                      }))
                    }
                    disabled={editor.pending}
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-editor-interval-unit`
                        : undefined
                    }
                  >
                    <option value="seconds">{t("triggers.schedules.units.seconds")}</option>
                    <option value="minutes">{t("triggers.schedules.units.minutes")}</option>
                    <option value="hours">{t("triggers.schedules.units.hours")}</option>
                  </Select>
                </div>
              </div>
            ) : null}

            {editor.scheduleType === "daily" ? (
              <div className="space-y-2">
                <label className="text-xs font-medium text-ui-muted">
                  {t("triggers.schedules.fields.dailyTime")}
                </label>
                <Input
                  type="time"
                  value={editor.dailyTime}
                  onChange={(event) =>
                    setEditor((current) => ({ ...current, dailyTime: event.target.value }))
                  }
                  disabled={editor.pending}
                  data-testid={
                    resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-daily-time` : undefined
                  }
                />
              </div>
            ) : null}

            {editor.scheduleType === "weekly" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-ui-muted">
                    {t("triggers.schedules.fields.weekday")}
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {Array.from({ length: 7 }, (_, index) => {
                      const value = String(index);
                      const checked = editor.weeklyDays.includes(value);
                      return (
                        <label
                          key={value}
                          className="flex items-center gap-2 text-xs text-ui-muted"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-ui-border"
                            checked={checked}
                            onChange={(event) =>
                              setEditor((current) => {
                                const next = new Set(current.weeklyDays);
                                if (event.target.checked) next.add(value);
                                else next.delete(value);
                                return { ...current, weeklyDays: Array.from(next).sort() };
                              })
                            }
                            disabled={editor.pending}
                            data-testid={
                              resolvedTestIdPrefix
                                ? `${resolvedTestIdPrefix}-editor-weekday-${value}`
                                : undefined
                            }
                          />
                          <span className="text-ui-ink">
                            {t(`triggers.schedules.weekdays.${value}`)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-ui-muted">
                    {t("triggers.schedules.fields.weeklyTime")}
                  </label>
                  <Input
                    type="time"
                    value={editor.weeklyTime}
                    onChange={(event) =>
                      setEditor((current) => ({ ...current, weeklyTime: event.target.value }))
                    }
                    disabled={editor.pending}
                    data-testid={
                      resolvedTestIdPrefix
                        ? `${resolvedTestIdPrefix}-editor-weekly-time`
                        : undefined
                    }
                  />
                </div>
              </div>
            ) : null}

            <label className="flex items-start gap-2 text-xs text-ui-muted">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-ui-border"
                checked={editor.enabled}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, enabled: event.target.checked }))
                }
                disabled={editor.pending}
                data-testid={
                  resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-enabled` : undefined
                }
              />
              <span className="space-y-1">
                <span className="block font-medium text-ui-ink">
                  {t("triggers.schedules.fields.enabled")}
                </span>
                <span className="block">{t("triggers.schedules.fields.enabledHint")}</span>
              </span>
            </label>

            <div className="space-y-2">
              <label className="text-xs font-medium text-ui-muted">
                {t("triggers.schedules.fields.notes")}
              </label>
              <Input
                value={editor.notes}
                onChange={(event) =>
                  setEditor((current) => ({ ...current, notes: event.target.value }))
                }
                placeholder={t("triggers.schedules.fields.notesPlaceholder")}
                disabled={editor.pending}
                data-testid={
                  resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-notes` : undefined
                }
              />
            </div>

            <WorkflowTriggerContextPatchControls
              value={editor.contextPatchText}
              onChange={(contextPatchText) => setEditor((current) => ({ ...current, contextPatchText }))}
              lookupOptions={lookupOptions}
              disabled={editor.pending}
              label={t("triggers.schedules.fields.contextPatch")}
              hint={t("triggers.schedules.fields.contextPatchHint")}
              invalidContextPatchMessage={t("triggers.schedules.toast.invalidContextPatch")}
              formatLabel={t("steps.builder.editor.metadata.actions.format")}
              resetLabel={t("steps.builder.editor.metadata.actions.reset")}
              lookupTestId={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-context-lookups` : undefined}
              textareaTestId={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-context-patch` : undefined}
              formatTestId={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-format-json` : undefined}
              resetTestId={resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-reset-json` : undefined}
            />
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
                {t("triggers.schedules.create.cancel")}
              </Button>
            </ModalClose>
            <Button
              type="button"
              onClick={() => void submitEditor()}
              disabled={!canSubmitEditor}
              data-testid={
                resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-editor-submit` : undefined
              }
            >
              {editor.pending
                ? t("triggers.schedules.create.submitting")
                : t("triggers.schedules.create.submit")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal
        open={del.open}
        onOpenChange={(nextOpen) => {
          if (del.pending && !nextOpen) return;
          if (!nextOpen) setDel(buildInitialDelete());
        }}
      >
        <ModalContent
          data-testid={
            resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-delete-modal` : undefined
          }
        >
          <ModalHeader>
            <ModalTitle>{t("triggers.schedules.deleteConfirm.title")}</ModalTitle>
            <ModalDescription>{t("triggers.schedules.deleteConfirm.description")}</ModalDescription>
          </ModalHeader>
          <ModalFooter>
            <ModalClose asChild>
              <Button type="button" variant="ghost" disabled={del.pending}>
                {t("triggers.schedules.deleteConfirm.cancel")}
              </Button>
            </ModalClose>
            <Button type="button" onClick={() => void confirmDelete()} disabled={del.pending}>
              {t("triggers.schedules.deleteConfirm.confirm")}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );

  async function handleRunNow(row: Record<string, unknown>) {
    if (!canWrite || busyId || editor.pending || del.pending) return;
    const triggerId = normalizeText(row.id);
    if (!triggerId) return;
    setBusyId(triggerId);
    let accepted = false;
    try {
      const ui = createUiClient();
      const result = await ui.runWorkflowScheduleTrigger(triggerId);
      const runId = result?.workflow_run_id?.trim() ?? "";
      if (!runId) {
        toast({
          tone: "error",
          title: t("triggers.schedules.toast.runErrorTitle"),
          description: t("triggers.schedules.toast.runErrorMissingRun"),
        });
        return;
      }
      accepted = true;
      setRunReceipts((current) => ({ ...current, [triggerId]: runId }));
      if (safeBasePath === null) {
        toast({
          tone: "warning",
          title: t("triggers.schedules.toast.runStarted"),
          description: readbackT("toast.readbackErrorDescription"),
        });
        return;
      }
      const destination = resolveWorkflowRunDestination({
        appBasePath: safeBasePath,
        result,
      });
      const resolvedDestination =
        destination && destination.trim()
          ? destination.trim()
          : safeHref(`/workflows/runs/${encodeURIComponent(runId)}`);
      if (!resolvedDestination) {
        toast({
          tone: "warning",
          title: t("triggers.schedules.toast.runStarted"),
          description: readbackT("toast.readbackErrorDescription"),
        });
        return;
      }
      navigateTo(resolvedDestination);
      toast({ tone: "success", title: t("triggers.schedules.toast.runStarted") });
    } catch (error) {
      toast({
        tone: accepted ? "warning" : "error",
        title: t(accepted ? "triggers.schedules.toast.runStarted" : "triggers.schedules.toast.runErrorTitle"),
        description: formatUiError(error, accepted ? readbackT("toast.readbackErrorDescription") : t("triggers.schedules.toast.runErrorTitle")),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleEnabled(row: Record<string, unknown>) {
    if (!canWrite || busyId || editor.pending || del.pending) return;
    const triggerId = normalizeText(row.id);
    if (!triggerId) return;
    const nextEnabled = !(normalizeBoolean(row.enabled) ?? true);
    setBusyId(triggerId);
    try {
      const ui = createUiClient();
      const updated = await ui.updateResource({
        resource: "workflow_schedule_triggers",
        id: triggerId,
        patch: { enabled: nextEnabled },
      });
      if (updated && typeof updated === "object") {
        setRows((current) =>
          current.map((entry) =>
            normalizeText(entry.id) === triggerId
              ? (updated as Record<string, unknown>)
              : entry
          )
        );
      } else {
        setRows((current) =>
          current.map((entry) =>
            normalizeText(entry.id) === triggerId ? { ...entry, enabled: nextEnabled } : entry
          )
        );
      }
      toast({
        tone: "success",
        title: nextEnabled
          ? t("triggers.schedules.toast.enabled")
          : t("triggers.schedules.toast.disabled"),
      });
    } catch (error) {
      toast({
        tone: "error",
        title: t("triggers.schedules.toast.updateErrorTitle"),
        description: formatUiError(error, t("triggers.schedules.toast.updateErrorTitle")),
      });
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(row: Record<string, unknown>) {
    if (!canWrite || editor.pending || del.pending) return;
    const triggerId = normalizeText(row.id);
    if (!triggerId) return;
    const schedule = normalizeObject(row.schedule);
    const scheduleType = resolveScheduleType(schedule);
    const timezone = normalizeText(schedule?.timezone) ?? resolveTimeZone();

    const next: EditorState = {
      ...buildInitialEditor(),
      open: true,
      mode: "edit",
      triggerId,
      scheduleType,
      timezone,
      enabled: normalizeBoolean(row.enabled) ?? true,
      notes: normalizeText(row.notes) ?? "",
      contextPatchText: JSON.stringify(row.context_patch ?? {}, null, 2),
    };

    const atTime = resolveScheduleAtTime(schedule);
    const intervalSeconds = resolveScheduleIntervalSeconds(schedule);

    if (scheduleType === "daily") {
      const parsed = atTime ? parseTimeInput(atTime) : null;
      if (parsed) next.dailyTime = toTimeInputValue(parsed.hour, parsed.minute);
    } else if (scheduleType === "weekly") {
      const parsed = atTime ? parseTimeInput(atTime) : null;
      if (parsed) next.weeklyTime = toTimeInputValue(parsed.hour, parsed.minute);
      const weekdays = resolveScheduleWeekdays(schedule);
      if (weekdays.length > 0) next.weeklyDays = weekdays.map((value) => String(value));
    } else {
      if (intervalSeconds) {
        if (intervalSeconds % 3600 === 0) {
          next.intervalUnit = "hours";
          next.intervalValue = String(intervalSeconds / 3600);
        } else if (intervalSeconds % 60 === 0) {
          next.intervalUnit = "minutes";
          next.intervalValue = String(intervalSeconds / 60);
        } else {
          next.intervalUnit = "seconds";
          next.intervalValue = String(intervalSeconds);
        }
      }
    }

    setEditor(next);
  }

  function requestDelete(row: Record<string, unknown>) {
    if (!canWrite || editor.pending || del.pending) return;
    const triggerId = normalizeText(row.id);
    if (!triggerId) return;
    setDel({ open: true, triggerId, pending: false });
  }

  async function submitEditor() {
    if (!canWrite || editor.pending || del.pending) return;
    setEditor((current) => ({ ...current, pending: true }));
    try {
      const timezone = editor.timezone.trim() || resolveTimeZone();
      let schedule: Record<string, unknown>;
      if (editor.scheduleType === "daily") {
        const time = parseTimeInput(editor.dailyTime);
        if (!time) {
          throw new UiMessageError(t("triggers.schedules.toast.invalidTime"));
        }
        schedule = { type: "daily", at_time: toTimeInputValue(time.hour, time.minute), timezone };
      } else if (editor.scheduleType === "weekly") {
        const time = parseTimeInput(editor.weeklyTime);
        if (!time) {
          throw new UiMessageError(t("triggers.schedules.toast.invalidTime"));
        }
        const selected = editor.weeklyDays
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .map((value) => Math.trunc(value))
          .filter((value) => value >= 0 && value <= 6);
        const unique = Array.from(new Set(selected)).sort((a, b) => a - b);
        if (unique.length === 0) throw new UiMessageError(t("triggers.schedules.toast.invalidWeekday"));
        schedule = {
          type: "weekly",
          days_of_week: unique,
          at_time: toTimeInputValue(time.hour, time.minute),
          timezone,
        };
      } else {
        const value = Number(editor.intervalValue);
        if (!Number.isFinite(value) || value <= 0) {
          throw new UiMessageError(t("triggers.schedules.toast.invalidInterval"));
        }
        const multiplier =
          editor.intervalUnit === "hours"
            ? 3600
            : editor.intervalUnit === "minutes"
              ? 60
              : 1;
        const seconds = Math.trunc(value * multiplier);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new UiMessageError(t("triggers.schedules.toast.invalidInterval"));
        }
        schedule = { type: "interval", interval_seconds: seconds, timezone };
      }

      const contextPatch = contextPatchState.value;
      if (!contextPatch) {
        throw new UiMessageError(t("triggers.schedules.toast.invalidContextPatch"));
      }

      const ui = createUiClient();
      if (editor.mode === "create") {
        const created = await ui.createWorkflowScheduleTrigger({
          workflowTemplateId,
          schedule,
          contextPatch,
          enabled: editor.enabled,
          notes: editor.notes.trim() || null,
        });
        const triggerId = created?.workflow_schedule_trigger_id?.trim() ?? "";
        if (!triggerId) {
          toast({
            tone: "error",
            title: t("triggers.schedules.toast.createErrorTitle"),
            description: t("triggers.schedules.toast.createErrorMissingId"),
          });
          return;
        }
        const createdRow =
          created && typeof created === "object" ? (created as Record<string, unknown>) : {};
        const nextRow: Record<string, unknown> = {
          ...createdRow,
          id: normalizeText(createdRow.id) ?? triggerId,
          workflow_template_id: workflowTemplateId,
          schedule,
          context_patch: contextPatch,
          enabled: editor.enabled,
          notes: editor.notes.trim() || null,
        };
        setRows((current) => {
          const nextId = normalizeText(nextRow.id) ?? triggerId;
          const filtered = current.filter((entry) => normalizeText(entry.id) !== nextId);
          return [...filtered, nextRow];
        });
        toast({ tone: "success", title: t("triggers.schedules.toast.created") });
      } else if (editor.triggerId) {
        const updated = await ui.updateResource({
          resource: "workflow_schedule_triggers",
          id: editor.triggerId,
          patch: {
            schedule,
            context_patch: contextPatch,
            enabled: editor.enabled,
            notes: editor.notes.trim() || null,
          },
        });
        const nextRow =
          updated && typeof updated === "object"
            ? (updated as Record<string, unknown>)
            : {
                id: editor.triggerId,
                workflow_template_id: workflowTemplateId,
                schedule,
                context_patch: contextPatch,
                enabled: editor.enabled,
                notes: editor.notes.trim() || null,
              };
        setRows((current) =>
          current.map((entry) =>
            normalizeText(entry.id) === editor.triggerId
              ? { ...entry, ...nextRow }
              : entry
          )
        );
        toast({ tone: "success", title: t("triggers.schedules.toast.updated") });
      }

      setEditor(buildInitialEditor());
      queryClient.invalidateQueries({ queryKey: ["resource"] });
    } catch (error) {
      const fallbackTitle =
        editor.mode === "create"
          ? t("triggers.schedules.toast.createErrorTitle")
          : t("triggers.schedules.toast.updateErrorTitle");
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
      await ui.rpc("ui_delete_resource_v1", {
        p_resource: "workflow_schedule_triggers",
        p_id: del.triggerId,
      });
      toast({ tone: "success", title: t("triggers.schedules.toast.deleted") });
      setRows((current) =>
        current.filter((entry) => normalizeText(entry.id) !== del.triggerId)
      );
      setDel(buildInitialDelete());
      queryClient.invalidateQueries({ queryKey: ["resource"] });
    } catch (error) {
      toast({
        tone: "error",
        title: t("triggers.schedules.toast.deleteErrorTitle"),
        description: formatUiError(error, t("triggers.schedules.toast.deleteErrorTitle")),
      });
      setDel((current) => ({ ...current, pending: false }));
    }
  }
}
