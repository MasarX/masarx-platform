"use client";
import * as React from "react";
import { Button } from "../button";
import { Input } from "../input";
import type {
  AccessPolicyTranslator,
  PolicyDeny,
} from "./types";

type DenyOverridesProps = {
  t: AccessPolicyTranslator;
  denies: PolicyDeny[];
  newDenyCapability: string;
  onNewDenyCapabilityChange: (value: string) => void;
  newDenyScopeType: string;
  onNewDenyScopeTypeChange: (value: string) => void;
  newDenyScopeId: string;
  onNewDenyScopeIdChange: (value: string) => void;
  newDenyReason: string;
  onNewDenyReasonChange: (value: string) => void;
  denyError: string | null;
  onAddDeny: () => void;
  onUpdateDeny: (index: number, patch: Partial<PolicyDeny>) => void;
  onRemoveDeny: (index: number) => void;
};

export function DenyOverrides({
  t,
  denies,
  newDenyCapability,
  onNewDenyCapabilityChange,
  newDenyScopeType,
  onNewDenyScopeTypeChange,
  newDenyScopeId,
  onNewDenyScopeIdChange,
  newDenyReason,
  onNewDenyReasonChange,
  denyError,
  onAddDeny,
  onUpdateDeny,
  onRemoveDeny,
}: DenyOverridesProps) {
  return (
    <div className="space-y-4 rounded-2xl border border-ui-border bg-ui-surface/70 p-4">
      <div className="text-xs uppercase tracking-wide text-ui-muted">
        {t("denies.title", { count: denies.length })}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Input
          value={newDenyCapability}
          onChange={(event) => onNewDenyCapabilityChange(event.target.value)}
          placeholder={t("denies.add.capabilityPlaceholder")}
          aria-label={t("denies.add.capabilityAria")}
        />
        <Input
          value={newDenyScopeType}
          onChange={(event) => onNewDenyScopeTypeChange(event.target.value)}
          placeholder={t("denies.add.scopeTypePlaceholder")}
          aria-label={t("denies.add.scopeTypeAria")}
        />
        <Input
          value={newDenyScopeId}
          onChange={(event) => onNewDenyScopeIdChange(event.target.value)}
          placeholder={t("denies.add.scopeIdPlaceholder")}
          aria-label={t("denies.add.scopeIdAria")}
        />
        <Input
          value={newDenyReason}
          onChange={(event) => onNewDenyReasonChange(event.target.value)}
          placeholder={t("denies.add.reasonPlaceholder")}
          aria-label={t("denies.add.reasonAria")}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={onAddDeny}>
          {t("denies.add.action")}
        </Button>
        {denyError ? (
          <div className="text-xs text-ui-danger">{denyError}</div>
        ) : null}
      </div>
      <div className="space-y-2">
        {denies.length === 0 ? (
          <div className="text-sm text-ui-muted">{t("denies.empty")}</div>
        ) : (
          denies.map((deny, index) => (
            <div
              key={`${deny.capability_key}-${index}`}
              className="grid gap-2 rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm sm:grid-cols-[1.4fr_1fr_1fr_1.4fr_auto]"
            >
              <Input
                value={deny.capability_key}
                onChange={(event) =>
                  onUpdateDeny(index, { capability_key: event.target.value })
                }
                className="rounded-lg"
                aria-label={t("denies.edit.capabilityAria", {
                  index: index + 1,
                })}
              />
              <Input
                value={deny.scope_type ?? ""}
                onChange={(event) =>
                  onUpdateDeny(index, { scope_type: event.target.value })
                }
                className="rounded-lg"
                aria-label={t("denies.edit.scopeTypeAria", { index: index + 1 })}
              />
              <Input
                value={deny.scope_id ?? ""}
                onChange={(event) =>
                  onUpdateDeny(index, { scope_id: event.target.value })
                }
                className="rounded-lg"
                aria-label={t("denies.edit.scopeIdAria", { index: index + 1 })}
              />
              <Input
                value={deny.reason ?? ""}
                onChange={(event) =>
                  onUpdateDeny(index, { reason: event.target.value })
                }
                className="rounded-lg"
                aria-label={t("denies.edit.reasonAria", { index: index + 1 })}
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => onRemoveDeny(index)}
              >
                {t("common.remove")}
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
