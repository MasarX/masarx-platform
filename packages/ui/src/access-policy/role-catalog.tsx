"use client";
import * as React from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import { Input } from "../input";
import type {
  AccessPolicyTranslator,
  PolicyCapability,
  PolicyRole,
} from "./types";

type RoleCatalogProps = {
  t: AccessPolicyTranslator;
  roles: PolicyRole[];
  capabilities: PolicyCapability[];
  selectedRoleKey: string | null;
  onSelectRole: (key: string) => void;
  roleFilter: string;
  onRoleFilterChange: (value: string) => void;
  capabilityFilter: string;
  onCapabilityFilterChange: (value: string) => void;
  newRoleKey: string;
  onNewRoleKeyChange: (value: string) => void;
  newRoleLabel: string;
  onNewRoleLabelChange: (value: string) => void;
  newRoleDescription: string;
  onNewRoleDescriptionChange: (value: string) => void;
  roleError: string | null;
  onAddRole: () => void;
  onUpdateRole: (roleKey: string, patch: Partial<PolicyRole>) => void;
  resolveRoleLabel?: (roleKey: string) => string;
  resolveCapabilityLabel?: (capabilityKey: string) => string;
  onRenameRole: (roleKey: string, nextKey: string) => void;
  onToggleWildcard: (roleKey: string) => void;
  onToggleCapability: (roleKey: string, capabilityKey: string) => void;
  onRemoveRole: (role: PolicyRole) => void;
};

const filterRoles = (roles: PolicyRole[], filterValue: string) => {
  if (!filterValue) return roles;
  const needle = filterValue.trim().toLowerCase();
  return roles.filter((role) => {
    return (
      role.key.toLowerCase().includes(needle) ||
      (role.label ?? "").toLowerCase().includes(needle)
    );
  });
};

const filterCapabilities = (
  capabilities: PolicyCapability[],
  filterValue: string
) => {
  if (!filterValue) return capabilities;
  const needle = filterValue.trim().toLowerCase();
  return capabilities.filter((capability) => {
    return (
      capability.key.toLowerCase().includes(needle) ||
      (capability.label ?? "").toLowerCase().includes(needle)
    );
  });
};

export function RoleCatalog({
  t,
  roles,
  capabilities,
  selectedRoleKey,
  onSelectRole,
  roleFilter,
  onRoleFilterChange,
  capabilityFilter,
  onCapabilityFilterChange,
  newRoleKey,
  onNewRoleKeyChange,
  newRoleLabel,
  onNewRoleLabelChange,
  newRoleDescription,
  onNewRoleDescriptionChange,
  roleError,
  onAddRole,
  onUpdateRole,
  resolveRoleLabel,
  resolveCapabilityLabel,
  onRenameRole,
  onToggleWildcard,
  onToggleCapability,
  onRemoveRole,
}: RoleCatalogProps) {
  const normalizedRoles = React.useMemo(
    () => filterRoles(roles, roleFilter),
    [roles, roleFilter]
  );
  const normalizedCapabilities = React.useMemo(
    () => filterCapabilities(capabilities, capabilityFilter),
    [capabilities, capabilityFilter]
  );
  const selectedRole =
    roles.find((role) => role.key === selectedRoleKey) ?? null;

  return (
    <div className="space-y-3 rounded-2xl border border-ui-border bg-ui-surface/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs tracking-wide text-ui-muted">
            {t("roles.title", { count: roles.length })}
          </div>
          <div className="text-sm text-ui-muted">{t("roles.subtitle")}</div>
        </div>
        <Input
          value={roleFilter}
          onChange={(event) => onRoleFilterChange(event.target.value)}
          placeholder={t("roles.searchPlaceholder")}
          className="w-full max-w-xs"
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-[240px,1fr]">
        <div className="space-y-2">
          {normalizedRoles.length === 0 ? (
            <div className="rounded-lg border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted">
              {t("roles.empty")}
            </div>
          ) : (
            normalizedRoles.map((role) => (
              <button
                key={role.key}
                type="button"
                onClick={() => onSelectRole(role.key)}
                className={`flex w-full flex-col rounded-lg border px-3 py-2 text-left text-sm ${
                  role.key === selectedRoleKey
                    ? "border-ui-ink bg-ui-highlight"
                    : "border-ui-border bg-ui-surface/80 text-ui-muted hover:bg-ui-highlight/50 hover:text-ui-ink"
                }`}
              >
                <span className="font-semibold">{resolveRoleLabel?.(role.key) ?? role.label ?? role.key}</span>
                <span className="text-xs opacity-70">{role.key}</span>
              </button>
            ))
          )}
          <div className="mt-4 space-y-2 rounded-lg border border-ui-border bg-ui-surface/80 p-3">
            <div className="text-xs tracking-wide text-ui-muted">
              {t("roles.add.title")}
            </div>
            <Input
              value={newRoleKey}
              onChange={(event) => onNewRoleKeyChange(event.target.value)}
              placeholder={t("roles.add.keyPlaceholder")}
              aria-label={t("roles.add.keyAria")}
            />
            <Input
              value={newRoleLabel}
              onChange={(event) => onNewRoleLabelChange(event.target.value)}
              placeholder={t("roles.add.labelPlaceholder")}
              aria-label={t("roles.add.labelAria")}
            />
            <Input
              value={newRoleDescription}
              onChange={(event) => onNewRoleDescriptionChange(event.target.value)}
              placeholder={t("roles.add.descriptionPlaceholder")}
              aria-label={t("roles.add.descriptionAria")}
            />
            <Button type="button" onClick={onAddRole}>
              {t("roles.add.action")}
            </Button>
            {roleError ? (
              <div className="text-xs text-ui-danger">{roleError}</div>
            ) : null}
          </div>
        </div>
        <div className="space-y-4 rounded-xl border border-ui-border bg-ui-surface/80 p-4">
          {selectedRole ? (
            <>
              <div className="space-y-2">
                <div className="text-xs tracking-wide text-ui-muted">
                  {t("roles.details.title")}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 text-sm text-ui-ink">
                    <span className="text-xs tracking-wide text-ui-muted">
                      {t("roles.details.key")}
                    </span>
                    <Input
                      defaultValue={selectedRole.key}
                      onBlur={(event) =>
                        onRenameRole(selectedRole.key, event.target.value)
                      }
                      className="w-full"
                    />
                  </label>
                  <label className="space-y-1 text-sm text-ui-ink">
                    <span className="text-xs tracking-wide text-ui-muted">
                      {t("roles.details.label")}
                    </span>
                    <Input
                      value={selectedRole.label ?? selectedRole.key}
                      onChange={(event) =>
                        onUpdateRole(selectedRole.key, {
                          label: event.target.value,
                        })
                      }
                      className="w-full"
                    />
                  </label>
                </div>
                <label className="space-y-1 text-sm text-ui-ink">
                  <span className="text-xs tracking-wide text-ui-muted">
                    {t("roles.details.description")}
                  </span>
                  <Input
                    value={selectedRole.description ?? ""}
                    onChange={(event) =>
                      onUpdateRole(selectedRole.key, {
                        description: event.target.value,
                      })
                    }
                    className="w-full"
                  />
                </label>
              </div>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs tracking-wide text-ui-muted">
                    {t("roles.capabilities.title")}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-ui-muted">
                    <Checkbox
                      checked={(selectedRole.capability_keys ?? []).includes("*")}
                      onChange={() => onToggleWildcard(selectedRole.key)}
                    />
                    {t("roles.capabilities.fullAccess")}
                  </label>
                </div>
                <Input
                  value={capabilityFilter}
                  onChange={(event) => onCapabilityFilterChange(event.target.value)}
                  placeholder={t("roles.capabilities.searchPlaceholder")}
                  className="w-full"
                />
                <div className="max-h-64 space-y-2 overflow-auto rounded-lg border border-ui-border bg-ui-surface/60 p-3">
                  {normalizedCapabilities.length === 0 ? (
                    <div className="text-sm text-ui-muted">
                      {t("roles.capabilities.empty")}
                    </div>
                  ) : (
                    normalizedCapabilities.map((capability) => {
                      const key = capability.key;
                      const assigned =
                        selectedRole.capability_keys?.includes("*") ||
                        selectedRole.capability_keys?.includes(key);
                      return (
                        <label
                          key={key}
                          className="flex items-start gap-3 text-sm text-ui-ink"
                        >
                          <Checkbox
                            checked={Boolean(assigned)}
                            disabled={selectedRole.capability_keys?.includes("*")}
                            onChange={() => onToggleCapability(selectedRole.key, key)}
                          />
                          <div>
                            <div className="font-semibold">
                              {resolveCapabilityLabel?.(key) ?? capability.label ?? key}
                            </div>
                            <div className="text-xs text-ui-muted">{key}</div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-ui-border pt-3">
                <div className="text-xs text-ui-muted">
                  {selectedRole.capability_keys?.length ?? 0} assigned
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onRemoveRole(selectedRole)}
                >
                  {t("roles.remove")}
                </Button>
              </div>
            </>
          ) : (
            <div className="text-sm text-ui-muted">{t("roles.selectHint")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
