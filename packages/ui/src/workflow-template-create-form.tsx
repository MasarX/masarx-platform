"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createUiClient, isRetriableNetworkError, isRetriableSupabaseError } from "@masarx/api";
import { Button } from "./button";
import { Input } from "./input";
import { Select } from "./select";
import { Textarea } from "./textarea";
import { createUiTranslator } from "./i18n";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { useToast } from "./use-toast";
import { formatUiError, isStatementTimeoutUiError } from "./utils";
import { isTimeoutError, resolveUiRpcTimeoutMs, withTimeout } from "./promise-timeout";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";
import { useUnsavedChangesGuard } from "./use-unsaved-changes";

export type WorkflowTemplateOption = {
  id: string;
  name: string;
  status?: string | null;
  version?: number | null;
};

type WorkflowTemplateCreateFormProps = {
  appBasePath: string;
  capabilities?: string[] | null;
  capabilityWrite?: string | null;
  templates?: WorkflowTemplateOption[] | null;
  testIdPrefix?: string | null;
};

export function WorkflowTemplateCreateForm({
  appBasePath,
  capabilities,
  capabilityWrite,
  templates,
  testIdPrefix,
}: WorkflowTemplateCreateFormProps) {
  const t = createUiTranslator("ui.workflowStudio");
  const router = useRouter();
  const { toast } = useToast();
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const nameTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-name` : undefined;
  const descriptionTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-description`
    : undefined;
  const cloneTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-clone` : undefined;
  const submitTestId = resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-submit` : undefined;

  const capabilitySet = React.useMemo(
    () => resolveCapabilitySet(capabilities),
    [capabilities]
  );
  const canCreate = capabilityWrite
    ? hasCapability(capabilitySet, capabilityWrite)
    : false;
  const canResolvePermissions = Boolean(capabilityWrite);

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [cloneFrom, setCloneFrom] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const hasChanges = Boolean(name.trim() || description.trim() || cloneFrom.trim());
  useUnsavedChangesGuard({
    enabled: true,
    isSubmitting: pending,
    hasChanges,
    warningMessage: t("create.unsavedWarning"),
  });
  const createTimeoutMs = React.useMemo(() => resolveUiRpcTimeoutMs(), []);
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath),
    [appBasePath]
  );

  const shouldRetry = React.useCallback((error: unknown) => {
    if (isTimeoutError(error)) return true;
    if (isStatementTimeoutUiError(error)) return true;
    if (isRetriableSupabaseError(error)) return true;
    if (isRetriableNetworkError(error)) return true;
    return false;
  }, []);

  const delay = React.useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
      }),
    []
  );

  const options = React.useMemo(() => {
    const list = Array.isArray(templates) ? templates : [];
    return list
      .map((entry) => ({
        id: entry.id,
        label: entry.status
          ? `${entry.name} (${entry.status}${entry.version ? ` v${entry.version}` : ""})`
          : entry.name,
      }))
      .filter((entry) => entry.id && entry.label);
  }, [templates]);

  const handleSubmit = React.useCallback(async () => {
    if (!canCreate || pending) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast({
        tone: "error",
        title: t("create.toast.nameRequiredTitle"),
        description: t("create.toast.nameRequiredDescription"),
      });
      return;
    }
    setPending(true);
    try {
      const ui = createUiClient();
      const payload = {
        name: trimmed,
        description: description.trim() ? description.trim() : null,
        cloneFrom: cloneFrom.trim() ? cloneFrom.trim() : null,
      };
      const maxAttempts = 2;
      const retryDelayMs = 800;
      let result: Awaited<ReturnType<typeof ui.createWorkflowTemplate>> | null = null;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          result = await withTimeout(ui.createWorkflowTemplate(payload), createTimeoutMs);
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= maxAttempts || !shouldRetry(error)) {
            throw error;
          }
          await delay(retryDelayMs);
        }
      }

      if (!result && lastError) {
        throw lastError;
      }
      const workflowTemplateId = result?.workflow_template_id?.trim() ?? null;
      if (!workflowTemplateId) {
        toast({
          tone: "error",
          title: t("create.toast.errorTitle"),
          description: t("create.toast.errorMissingTemplate"),
        });
        return;
      }
      const templateHref = safeBasePath !== null
        ? resolveSafeHref(
            safeBasePath,
            `/workflows/templates/${encodeURIComponent(workflowTemplateId)}`
          )
        : null;
      if (!templateHref) {
        toast({
          tone: "error",
          title: t("create.toast.errorTitle"),
          description: t("create.toast.errorTitle"),
        });
        return;
      }
      router.push(templateHref);
      toast({ tone: "success", title: t("create.toast.successTitle") });
    } catch (error) {
      if (isTimeoutError(error) || isStatementTimeoutUiError(error)) {
        toast({
          tone: "error",
          title: t("create.toast.timeoutTitle"),
          description: t("create.toast.timeoutDescription"),
        });
        return;
      }
      toast({
        tone: "error",
        title: t("create.toast.errorTitle"),
        description: formatUiError(error, t("create.toast.errorTitle")),
      });
    } finally {
      setPending(false);
    }
  }, [
    canCreate,
    cloneFrom,
    createTimeoutMs,
    description,
    name,
    pending,
    router,
    safeBasePath,
    shouldRetry,
    t,
    toast,
  ]);

  return (
    <div className="space-y-4">
      {!canCreate ? (
        <p className="text-sm text-ui-muted">
          {canResolvePermissions
            ? t("create.permissions.denied")
            : t("create.permissions.unavailable")}
        </p>
      ) : null}
      <div className="space-y-2">
        <label className="text-xs font-medium text-ui-muted">
          {t("create.fields.name")}
        </label>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("create.fields.namePlaceholder")}
          disabled={!canCreate || pending}
          data-testid={nameTestId}
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-ui-muted">
          {t("create.fields.description")}
        </label>
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("create.fields.descriptionPlaceholder")}
          disabled={!canCreate || pending}
          data-testid={descriptionTestId}
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-ui-muted">
          {t("create.fields.clone")}
        </label>
        <Select
          value={cloneFrom}
          onChange={(event) => setCloneFrom(event.target.value)}
          disabled={!canCreate || pending || options.length === 0}
          data-testid={cloneTestId}
        >
          <option value="">{t("create.fields.cloneNone")}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-ui-muted">{t("create.fields.cloneHint")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={!canCreate || pending}
          data-testid={submitTestId}
        >
          {pending ? t("create.submitCreating") : t("create.submit")}
        </Button>
      </div>
    </div>
  );
}
