import {
  matchesResourceCategory,
  resolveResourceCommandCategory,
  type UiCommandDefinition,
  type UiReadResource,
} from "@masarx/api";
import { getUiDefaults } from "@masarx/config";
import { resolveCommandHref } from "./command-utils";
import type { BulkActionDefinition } from "./bulk-actions";
import type { TranslateFn } from "./table/types";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { resolveRowDisplayText } from "./i18n";
import { resolveSafeHref } from "./url-guard";

const uiDefaults = getUiDefaults();

type ResourceActionsInput = {
  t: TranslateFn;
  resourceKey: string;
  resource?: UiReadResource | null;
  commands: UiCommandDefinition[];
  appKey: "console" | "portal";
  appBasePath: string;
  downloadBasePath: string;
  userCapabilities: string[];
  maxDownloadBatch?: number;
  locale?: string;
};

type ResourceActionStatsInput = {
  resource?: UiReadResource | null;
  commands: UiCommandDefinition[];
  userCapabilities: string[];
};

export { matchesResourceCategory, resolveResourceCommandCategory };

export type ResourceActionStats = {
  total: number;
  allowed: number;
  blocked: number;
};

const resolveDownloadCapability = (resource?: UiReadResource | null) =>
  resource?.download?.capability?.trim() ?? null;

const resolveDownloadAllowed = (
  downloadCapability: string | null,
  capabilitySet: Set<string>
) => hasCapability(capabilitySet, downloadCapability);

const resolveCreateActionHref = (
  resource: UiReadResource | null | undefined,
  appBasePath: string
) => {
  const createConfig = resource?.create ?? null;
  if (createConfig?.enabled !== true) return null;
  const route = createConfig.route?.trim();
  if (!route) return null;
  return resolveSafeHref(appBasePath, route);
};

const resolveCreateCapability = (resource: UiReadResource | null | undefined) =>
  resource?.create?.capability?.trim() || null;

const resolveLabel = (command: UiCommandDefinition, locale?: string) =>
  resolveRowDisplayText(command.label?.trim() || command.key, command.label_ar, locale);

const resolveExecutionType = (
  command: UiCommandDefinition,
  href: string | null
) =>
  command.execution?.type ??
  (href
    ? "navigate"
    : command.binding_key || command.execution?.binding_key
      ? "workflow_binding"
      : command.workflow_key
      ? "workflow"
      : command.execution?.rpc
        ? "rpc"
        : "navigate");

const resolvePriority = (executionType: string) => {
  if (executionType === "print") return 0;
  if (executionType === "workflow" || executionType === "workflow_binding") return 1;
  if (executionType === "rpc") return 2;
  if (executionType === "navigate") return 3;
  return 4;
};

export const resolveResourceActionStats = ({
  resource,
  commands,
  userCapabilities,
}: ResourceActionStatsInput): ResourceActionStats => {
  const capabilitySet = resolveCapabilitySet(userCapabilities);
  const downloadCapability = resolveDownloadCapability(resource);
  const downloadConfigured = Boolean(resource?.download);
  const downloadAllowed =
    downloadConfigured && resolveDownloadAllowed(downloadCapability, capabilitySet);
  const allowedCommands = commands.filter((command) => {
    return hasCapability(capabilitySet, command.capability);
  });
  const total = commands.length + (downloadConfigured ? 1 : 0);
  const allowed =
    allowedCommands.length + (downloadAllowed ? 1 : 0);
  const blocked = Math.max(total - allowed, 0);
  return { total, allowed, blocked };
};

export const resolveResourceBulkActions = ({
  t,
  resourceKey,
  resource,
  commands,
  appKey,
  appBasePath,
  downloadBasePath,
  userCapabilities,
  locale,
  maxDownloadBatch,
}: ResourceActionsInput): BulkActionDefinition[] => {
  const output: BulkActionDefinition[] = [];
  const capabilitySet = resolveCapabilitySet(userCapabilities);
  const downloadCapability = resolveDownloadCapability(resource);
  const downloadAllowed = resolveDownloadAllowed(downloadCapability, capabilitySet);
  const resolvedMaxBatch =
    maxDownloadBatch ?? uiDefaults.table.maxDownloadBatch;

  if (resource?.download) {
    const downloadDisabledReason = downloadAllowed
      ? null
      : t("disabled.requiresCapability", {
          capability: downloadCapability ?? "",
        });
    output.push({
      key: `${resourceKey}.download.labels`,
      label: t("downloadLabels"),
      capability: downloadCapability,
      resourceKey,
      execution: { type: "download" },
      disabledReason: downloadDisabledReason,
      selection: {
        min_count: 1,
        max_count: resolvedMaxBatch,
      },
      download: {
        resourceKey,
        downloadBasePath,
        maxBatch: resolvedMaxBatch,
      },
    });
  }

  const commandActions: Array<
    BulkActionDefinition & { __sort: { priority: number; label: string } }
  > = [];
  commands.forEach((command) => {
    const capability = command.capability?.trim() ?? null;
    const capabilityMissing =
      Boolean(capability) && !hasCapability(capabilitySet, capability);
    const href = resolveCommandHref(command, appBasePath, appKey);
    const executionType = resolveExecutionType(command, href);
    const rpcName = command.execution?.rpc?.trim() ?? null;
    const execution = {
      ...(command.execution ?? {}),
      type: executionType,
      rpc: rpcName,
    };
    const baseDisabledReason =
      executionType === "navigate" && !href
        ? t("disabled.noHref")
        : executionType === "rpc" && !rpcName
          ? t("disabled.noRpc")
          : (executionType === "workflow" ||
              executionType === "workflow_binding" ||
              executionType === "print") &&
              !rpcName &&
              !href
            ? t("disabled.noRpc")
            : null;
    const disabledReason = capabilityMissing
      ? t("disabled.requiresCapability", {
          capability: capability ?? "",
        })
      : baseDisabledReason;
    const label = resolveLabel(command, locale);
    commandActions.push({
      key: command.key,
      label,
      description: command.description ?? null,
      capability,
      resourceKey,
      workflowKey: command.workflow_key ?? null,
      href,
      selection: command.selection ?? null,
      execution,
      disabledReason,
      __sort: {
        priority: resolvePriority(executionType),
        label,
      },
    });
  });
  commandActions.sort((a, b) => {
    if (a.__sort.priority !== b.__sort.priority) {
      return a.__sort.priority - b.__sort.priority;
    }
    return a.__sort.label.localeCompare(b.__sort.label);
  });
  const commandActionsResolved = commandActions.map(
    ({ __sort, ...action }) => action
  );

  output.push(...commandActionsResolved);
  const existingKeys = new Set(output.map((a) => a.key));

  // Generic clone actions are available only for resources with registry-owned
  // create routes; write capability alone does not prove a concrete page exists.
  const cloneKey = `${resourceKey}.clone`;
  const createHref = resolveCreateActionHref(resource, appBasePath);
  const writeCapability = resolveCreateCapability(resource);
  if (!existingKeys.has(cloneKey) && createHref && writeCapability) {
    const cloneAllowed = hasCapability(capabilitySet, writeCapability);
    const cloneDisabledReason = cloneAllowed
      ? null
      : t("disabled.requiresCapability", { capability: writeCapability });
    output.push({
      key: cloneKey,
      label: t("clone"),
      description: null,
      capability: writeCapability,
      resourceKey,
      href: createHref,
      execution: { type: "navigate" },
      disabledReason: cloneDisabledReason,
      selection: { min_count: 1, max_count: 1, id_param: "clone_from" },
    });
  }

  return output;
};
