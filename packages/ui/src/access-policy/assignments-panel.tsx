"use client";
import * as React from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import { Input } from "../input";
import { Select } from "../select";
import type {
  AccessPolicyTranslator,
  PolicyAssignments,
  PolicyRole,
} from "./types";

type AssignmentsPanelProps = {
  t: AccessPolicyTranslator;
  assignments: PolicyAssignments;
  roles: PolicyRole[];
  newUserType: string;
  onNewUserTypeChange: (value: string) => void;
  newUserId: string;
  onNewUserIdChange: (value: string) => void;
  newUserIdRole: string;
  onNewUserIdRoleChange: (value: string) => void;
  onAddUserType: () => void;
  onRemoveUserType: (userType: string) => void;
  onUpdateAssignment: (userType: string, roleKey: string, enabled: boolean) => void;
  onAddUserIdAssignment: () => void;
  onRemoveUserIdRole: (userId: string, roleKey: string) => void;
};

export function AssignmentsPanel({
  t,
  assignments,
  roles,
  newUserType,
  onNewUserTypeChange,
  newUserId,
  onNewUserIdChange,
  newUserIdRole,
  onNewUserIdRoleChange,
  onAddUserType,
  onRemoveUserType,
  onUpdateAssignment,
  onAddUserIdAssignment,
  onRemoveUserIdRole,
}: AssignmentsPanelProps) {
  return (
    <div className="space-y-4 rounded-2xl border border-ui-border bg-ui-surface/70 p-4">
      <div className="text-xs uppercase tracking-wide text-ui-muted">
        {t("assignments.title")}
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={newUserType}
            onChange={(event) => onNewUserTypeChange(event.target.value)}
            placeholder={t("assignments.userTypePlaceholder")}
            className="w-full max-w-xs"
            aria-label={t("assignments.userTypeAria")}
          />
          <Button type="button" onClick={onAddUserType}>
            {t("assignments.addUserType")}
          </Button>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {Object.entries(assignments.user_type ?? {}).map(([userType, roleKeys]) => (
            <div
              key={userType}
              className="space-y-2 rounded-xl border border-ui-border bg-ui-surface/80 p-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ui-ink">{userType}</span>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onRemoveUserType(userType)}
                >
                  {t("common.remove")}
                </Button>
              </div>
              <div className="grid gap-2">
                {roles.map((role) => (
                  <label key={`${userType}-${role.key}`} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={roleKeys?.includes(role.key)}
                      onChange={(event) =>
                        onUpdateAssignment(userType, role.key, event.target.checked)
                      }
                    />
                    <span>{role.label ?? role.key}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          {Object.keys(assignments.user_type ?? {}).length === 0 ? (
            <div className="text-sm text-ui-muted">
              {t("assignments.userTypeEmpty")}
            </div>
          ) : null}
        </div>
      </div>
      <div className="space-y-3">
        <div className="text-xs uppercase tracking-wide text-ui-muted">
          {t("assignments.userIdTitle")}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            value={newUserId}
            onChange={(event) => onNewUserIdChange(event.target.value)}
            placeholder={t("assignments.userIdPlaceholder")}
            className="w-full max-w-xs"
            aria-label={t("assignments.userIdAria")}
          />
          <Select
            value={newUserIdRole}
            onChange={(event) => onNewUserIdRoleChange(event.target.value)}
            className="w-full max-w-xs"
            aria-label={t("assignments.userRoleAria")}
          >
            <option value="">{t("assignments.userRolePlaceholder")}</option>
            {roles.map((role) => (
              <option key={role.key} value={role.key}>
                {role.label ?? role.key}
              </option>
            ))}
          </Select>
          <Button type="button" onClick={onAddUserIdAssignment}>
            {t("assignments.addUserId")}
          </Button>
        </div>
        <div className="space-y-2">
          {Object.entries(assignments.user_id ?? {}).map(([userId, roleKeys]) => (
            <div
              key={userId}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-xs"
            >
              <span className="font-mono text-ui-ink">{userId}</span>
              <span className="text-ui-muted">{"->"}</span>
              {roleKeys.map((role) => (
                <Badge key={`${userId}-${role}`} tone="accent">
                  <span>{role}</span>
                  <button
                    type="button"
                    className="ml-2 text-xs text-ui-muted"
                    onClick={() => onRemoveUserIdRole(userId, role)}
                  >
                    {t("common.remove")}
                  </button>
                </Badge>
              ))}
            </div>
          ))}
          {Object.keys(assignments.user_id ?? {}).length === 0 ? (
            <div className="text-sm text-ui-muted">
              {t("assignments.userIdEmpty")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
