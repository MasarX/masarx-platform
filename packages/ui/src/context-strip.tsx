"use client";

import * as React from "react";
import type { UiScopeOption } from "@masarx/api";
import { Button } from "./button";
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from "./modal";
import { formatReferenceValue } from "./resource-utils";
import { createUiTranslator } from "./i18n";
import { Select } from "./select";
import { useToast } from "./use-toast";
import { labelFromKey } from "./resource-query";
import { useReadRegistry } from "./read-registry-client";
import { copyTextToClipboard } from "./clipboard";
import { isTrustedUrl, resolveBaseOrigin } from "./url-guard";
import { reportUiEvent } from "./reporting";

type ContextStripProps = {
  organizationId?: string | null;
  userId?: string | null;
  userLabel?: string | null;
  orgLabel?: string | null;
  scopeLabel?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
  scopeOptions?: UiScopeOption[] | null;
  scopeSwitcherMode?: "inline" | "details";
  scopeRequestHref?: string | null;
  scopeRequestId?: string | null;
  onScopeChange?: (href: string) => void;
  capabilityCount?: number | string | null;
  settingsResolutionId?: string | null;
  signOutHref?: string | null;
  signOutRequestId?: string | null;
  details?: ContextDetail[];
};

type ContextEntry = {
  key: "signed-in" | "org" | "scope" | "capabilities" | "settings";
  label: string;
  value: string;
  valueTitle?: string;
  tone?: "accent" | "neutral";
  monospace?: boolean;
  copyValue?: string;
};

type ContextDetail = {
  labelKey: string;
  value: string;
  monospace?: boolean;
  copyValue?: string;
};

function toText(value: string | null | undefined) {
  return value && value.trim() ? value.trim() : null;
}

const resolveScopeKey = (
  scopeType: string | null | undefined,
  scopeId: string | null | undefined
) => {
  const typeValue = scopeType?.trim() ?? "";
  if (!typeValue) return "";
  const idValue = scopeId?.trim() ?? "";
  return `${typeValue}::${idValue}`;
};

const resolveScopeOptionLabel = (option: UiScopeOption) => {
  const typeLabel = labelFromKey(option.scope_type);
  const rawLabel =
    option.scope_label?.trim() || option.scope_id?.trim() || "";
  if (!rawLabel) return typeLabel;
  const formattedLabel =
    option.scope_label?.trim() || formatReferenceValue(rawLabel);
  return `${typeLabel}: ${formattedLabel}`;
};

type NavigationWithRequestId = {
  href: string;
  requestId: string;
};

function normalizeRequestId(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function buildSignedHrefWithRequestId(
  rawHref: string,
  requestId: string | null | undefined
): NavigationWithRequestId | null {
  const normalizedRequestId = normalizeRequestId(requestId);
  try {
    const origin = typeof window === "undefined" ? resolveBaseOrigin() : window.location.origin;
    const url = new URL(rawHref, origin);
    if (normalizedRequestId) {
      url.searchParams.set("request_id", normalizedRequestId);
    }
    return {
      href: `${url.pathname}${url.search}${url.hash}`,
      requestId: normalizedRequestId ?? "",
    };
  } catch {
    return null;
  }
}

function resolveSignOutNavigation(
  rawSignOutHref: string | null,
  requestId: string | null | undefined
) {
  if (!rawSignOutHref) return null;
  return buildSignedHrefWithRequestId(rawSignOutHref, requestId);
}

function resolveTrackedNavigation(
  rawHref: string | null,
  requestId: string | null | undefined
): NavigationWithRequestId | null {
  if (!rawHref) return null;
  return buildSignedHrefWithRequestId(rawHref, requestId);
}

const normalizeScopeOptions = (options?: UiScopeOption[] | null) => {
  if (!Array.isArray(options)) return [];
  const normalized = new Map<
    string,
    UiScopeOption & { __key: string; __label: string }
  >();
  options.forEach((option) => {
    if (!option || !option.scope_type) return;
    const key = resolveScopeKey(option.scope_type, option.scope_id);
    if (!key || normalized.has(key)) return;
    normalized.set(key, {
      ...option,
      __key: key,
      __label: resolveScopeOptionLabel(option),
    });
  });
  return Array.from(normalized.values());
};

/**
 * Context strip showing user/org/scope metadata with optional sign-out link.
 */
export function ContextStrip({
  organizationId,
  userId,
  userLabel,
  orgLabel,
  scopeLabel,
  scopeType,
  scopeId,
  scopeOptions,
  scopeSwitcherMode = "inline",
  scopeRequestHref,
  scopeRequestId,
  onScopeChange,
  capabilityCount,
  settingsResolutionId,
  signOutHref,
  signOutRequestId,
  details = [],
}: ContextStripProps) {
  const t = createUiTranslator("ui.contextStrip");
  const { toast } = useToast();
  const entries: ContextEntry[] = [];
  const userValue = toText(userLabel);
  const orgValue = toText(orgLabel);
  const scopeValue = toText(scopeLabel);
  const settingsValue = toText(settingsResolutionId);
  const shouldFetchScopeOptions = !scopeOptions && Boolean(userValue);
  const { data: readRegistry } = useReadRegistry({
    userId, scopeType, scopeId,
    organizationId,
    enabled: shouldFetchScopeOptions,
    staleTime: 60_000,
  });
  const resolvedScopeOptions = scopeOptions ?? readRegistry?.scopes ?? null;
  const normalizedScopes = React.useMemo(
    () => normalizeScopeOptions(resolvedScopeOptions),
    [resolvedScopeOptions]
  );
  const activeScopeKey = resolveScopeKey(scopeType, scopeId);
  const scopeValueKey = normalizedScopes.some(
    (option) => option.__key === activeScopeKey
  )
    ? activeScopeKey
    : "";
  const scopeSwitcherId = React.useId();
  const hasScopeSwitcher = normalizedScopes.length > 0;
  const showInlineScopeSwitcher = hasScopeSwitcher && scopeSwitcherMode === "inline";
  const showDetailsScopeSwitcher = hasScopeSwitcher && scopeSwitcherMode === "details";
  const hasScopeRequest = Boolean(scopeRequestHref) && !hasScopeSwitcher;
  const hasDetailsModal = details.length > 0 || showDetailsScopeSwitcher;

  if (userValue) {
    entries.push({
      key: "signed-in",
      label: t("labels.signedIn"),
      value: userValue,
      tone: "accent",
    });
  }
  if (orgValue) {
    entries.push({ key: "org", label: t("labels.org"), value: orgValue });
  }
  if (scopeValue) {
    entries.push({ key: "scope", label: t("labels.scope"), value: scopeValue });
  }
  if (capabilityCount !== null && capabilityCount !== undefined) {
    entries.push({
      key: "capabilities",
      label: t("labels.capabilities"),
      value: String(capabilityCount),
    });
  }
  if (settingsValue) {
    entries.push({
      key: "settings",
      label: t("labels.settings"),
      value: formatReferenceValue(settingsValue),
      valueTitle: settingsValue,
      monospace: true,
      copyValue: settingsValue,
    });
  }

  const handleScopeNavigate = React.useCallback(
    (href: string) => {
      if (!isTrustedUrl(href)) {
        toast({
          title: t("scopeSwitcher.errors.missingHref"),
          tone: "error",
        });
        return;
      }
      if (onScopeChange) {
        onScopeChange(href);
        return;
      }
      window.location.assign(href);
    },
    [onScopeChange, t, toast]
  );
  const safeScopeRequestHref = React.useMemo(() => {
    const raw = scopeRequestHref?.trim();
    if (!raw) return null;
    if (!isTrustedUrl(raw)) return null;
    return raw;
  }, [scopeRequestHref]);
  const safeSignOutHref = React.useMemo(() => {
    const raw = signOutHref?.trim();
    if (!raw) return null;
    if (!isTrustedUrl(raw)) return null;
    return raw;
  }, [signOutHref]);
  const handleUnsafeLink = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      toast({
        title: t("scopeSwitcher.errors.missingHref"),
        tone: "error",
      });
    },
    [t, toast]
  );
  const safeSignOutNavigation = React.useMemo(
    () => resolveSignOutNavigation(safeSignOutHref, signOutRequestId),
    [safeSignOutHref, signOutRequestId]
  );
  const safeSignOutHrefWithRequestId = safeSignOutNavigation?.href ?? null;
  const safeScopeRequestNavigation = React.useMemo(
    () => resolveTrackedNavigation(safeScopeRequestHref, scopeRequestId),
    [safeScopeRequestHref, scopeRequestId]
  );
  const safeScopeRequestHrefWithRequestId =
    safeScopeRequestNavigation?.href ?? null;
  const handleSignOut = React.useCallback(() => {
    if (!safeSignOutNavigation) {
      return;
    }
    reportUiEvent({
      type: "ui.context_strip.sign_out.start",
      timestamp: new Date().toISOString(),
      context: "ContextStrip",
      name: "sign_out.click",
      digest: safeSignOutNavigation.requestId || undefined,
      requestId: safeSignOutNavigation.requestId || undefined,
      meta: {
        signOutHref: safeSignOutHref,
      },
    });
  }, [safeSignOutNavigation, safeSignOutHref]);
  const handleScopeRequest = React.useCallback(() => {
    if (!safeScopeRequestNavigation) {
      return;
    }
    reportUiEvent({
      type: "ui.context_strip.scope_request.start",
      timestamp: new Date().toISOString(),
      context: "ContextStrip",
      name: "scope_request.click",
      digest: safeScopeRequestNavigation.requestId || undefined,
      requestId: safeScopeRequestNavigation.requestId || undefined,
      meta: {
        scopeRequestHref: safeScopeRequestHref,
      },
    });
  }, [safeScopeRequestNavigation, safeScopeRequestHref]);

  const handleScopeSelect = React.useCallback(
    (nextKey: string) => {
      if (!nextKey) return;
      const option = normalizedScopes.find((entry) => entry.__key === nextKey);
      if (!option) return;
      const href = option.href?.trim() ?? "";
      if (!href) {
        toast({
          title: t("scopeSwitcher.errors.missingHref"),
          tone: "error",
        });
        return;
      }
      handleScopeNavigate(href);
    },
    [handleScopeNavigate, normalizedScopes, t, toast]
  );

  const renderScopeSwitcher = ({
    wrapperClassName,
    testId,
  }: {
    wrapperClassName: string;
    testId: string;
  }) => (
    <div className={wrapperClassName}>
      <label
        htmlFor={scopeSwitcherId}
        className="text-[11px] font-medium text-ui-muted"
      >
        {t("scopeSwitcher.label")}
      </label>
      <Select
        id={scopeSwitcherId}
        aria-label={t("scopeSwitcher.aria")}
        value={scopeValueKey}
        onChange={(event) => handleScopeSelect(event.target.value)}
        data-testid={testId}
      >
        {scopeValueKey ? null : (
          <option value="">{t("scopeSwitcher.placeholder")}</option>
        )}
        {normalizedScopes.map((option) => (
          <option key={option.__key} value={option.__key} disabled={!option.href}>
            {option.__label}
          </option>
        ))}
      </Select>
    </div>
  );

  if (entries.length === 0 && !signOutHref && !hasScopeSwitcher && !hasScopeRequest) {
    return null;
  }

  const handleCopy = async (value: string, label: string) => {
    try {
      const success = await copyTextToClipboard(value);
      if (success) {
        toast({
          title: t("actions.copied"),
          description: label,
          tone: "success",
        });
      } else {
        toast({
          title: t("actions.copyFailed"),
          tone: "error",
        });
      }
    } catch {
      toast({
        title: t("actions.copyFailed"),
        tone: "error",
      });
    }
  };

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg bg-ui-highlight/40 px-3 py-2 text-sm text-ui-muted">
      {entries.map((entry) => (
        <div
          key={entry.key}
          data-testid={`ui-context-strip-${entry.key}`}
          className="inline-flex items-center gap-2 rounded-md bg-ui-surface/60 px-2 py-1 transition hover:bg-ui-highlight/70"
        >
          <span className="text-[11px] font-medium text-ui-muted">
            {entry.label}
          </span>
          <span
            className={[
              "text-ui-ink",
              entry.tone === "accent" ? "font-medium" : "font-normal",
              entry.monospace ? "font-mono" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={entry.valueTitle}
          >
            {entry.value}
          </span>
          {entry.copyValue ? (
            <button
              type="button"
              className="text-[11px] font-medium text-ui-muted underline underline-offset-4 transition hover:text-ui-ink"
              aria-label={t("copyAria", { label: entry.label })}
              onClick={() => handleCopy(entry.copyValue ?? "", entry.label)}
            >
              {t("actions.copy")}
            </button>
          ) : null}
        </div>
      ))}
      {showInlineScopeSwitcher ? (
        renderScopeSwitcher({
          wrapperClassName: "flex items-center gap-2",
          testId: "ui-context-strip-scope-switcher-inline",
        })
      ) : null}
      {hasDetailsModal ? (
        <Modal>
          <ModalTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-testid="ui-context-strip-details-trigger"
            >
              {t("actions.details")}
            </Button>
          </ModalTrigger>
          <ModalContent data-testid="ui-context-strip-details-modal">
            <ModalHeader>
              <ModalTitle>{t("details.title")}</ModalTitle>
              <ModalDescription>{t("details.description")}</ModalDescription>
            </ModalHeader>
            <ModalBody>
              {showDetailsScopeSwitcher ? (
                renderScopeSwitcher({
                  wrapperClassName: "mb-6 space-y-2",
                  testId: "ui-context-strip-scope-switcher-details",
                })
              ) : null}
              <dl className="space-y-3">
                {details.map((detail) => (
                  <div key={`${detail.labelKey}-${detail.value}`}>
                    <dt className="text-[11px] font-medium text-ui-muted">
                      {t(detail.labelKey)}
                    </dt>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <dd
                        className={detail.monospace ? "font-mono text-ui-ink" : "text-ui-ink"}
                        title={detail.value}
                      >
                        {detail.monospace ? formatReferenceValue(detail.value) : detail.value}
                      </dd>
                      {detail.copyValue ? (
                        <button
                          type="button"
                          className="text-[11px] font-medium text-ui-ink underline underline-offset-4"
                          onClick={() => handleCopy(detail.copyValue ?? "", t(detail.labelKey))}
                        >
                          {t("actions.copy")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </dl>
            </ModalBody>
            <ModalFooter>
              <ModalClose asChild>
                <Button variant="ghost" size="sm">
                  {t("actions.close")}
                </Button>
              </ModalClose>
            </ModalFooter>
          </ModalContent>
        </Modal>
      ) : null}
      {hasScopeRequest ? (
        <a
          href={safeScopeRequestHrefWithRequestId ?? safeScopeRequestHref ?? "#"}
          onClick={safeScopeRequestNavigation ? handleScopeRequest : handleUnsafeLink}
          data-testid="ui-context-strip-scope-request"
          className="text-xs font-medium text-ui-ink underline underline-offset-4"
        >
          {t("scopeSwitcher.request")}
        </a>
      ) : null}
      {signOutHref ? (
        <a
          href={safeSignOutHrefWithRequestId ?? safeSignOutHref ?? "#"}
          onClick={safeSignOutHrefWithRequestId ? handleSignOut : handleUnsafeLink}
          data-testid="ui-context-strip-sign-out"
          className="ms-auto text-xs font-medium text-ui-ink underline underline-offset-4"
        >
          {t("signOut")}
        </a>
      ) : null}
    </div>
  );
}
