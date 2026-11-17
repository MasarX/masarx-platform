"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "./confirm-dialog";
import { AssignmentsPanel } from "./access-policy/assignments-panel";
import { CapabilityCatalog } from "./access-policy/capability-catalog";
import { DenyOverrides } from "./access-policy/deny-overrides";
import { RoleCatalog } from "./access-policy/role-catalog";
import {
  normalizePolicy,
  removeRoleKey,
  replaceRoleKey,
} from "./access-policy/normalize";
import type {
  PolicyDeny,
  PolicyRole,
} from "./access-policy/types";

type ConfirmAction =
  | { type: "role"; key: string; label: string }
  | { type: "capability"; key: string; label: string };

type AccessPolicyEditorProps = {
  policy: unknown;
  onChange: (nextPolicy: unknown) => void;
  testIdPrefix: string;
};

const toUniqueStrings = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

export function AccessPolicyEditor({
  policy,
  onChange,
  testIdPrefix,
}: AccessPolicyEditorProps) {
  const t = useTranslations("ui.accessPolicyEditor");
  const { base, roles, capabilities, assignments, denies } = React.useMemo(
    () => normalizePolicy(policy),
    [policy]
  );
  const [selectedRoleKey, setSelectedRoleKey] = React.useState<string | null>(
    roles[0]?.key ?? null
  );
  const [roleFilter, setRoleFilter] = React.useState("");
  const [capabilityFilter, setCapabilityFilter] = React.useState("");
  const [newRoleKey, setNewRoleKey] = React.useState("");
  const [newRoleLabel, setNewRoleLabel] = React.useState("");
  const [newRoleDescription, setNewRoleDescription] = React.useState("");
  const [newUserType, setNewUserType] = React.useState("");
  const [newUserId, setNewUserId] = React.useState("");
  const [newUserIdRole, setNewUserIdRole] = React.useState("");
  const [newDenyCapability, setNewDenyCapability] = React.useState("");
  const [newDenyScopeType, setNewDenyScopeType] = React.useState("");
  const [newDenyScopeId, setNewDenyScopeId] = React.useState("");
  const [newDenyReason, setNewDenyReason] = React.useState("");
  const [capabilityKey, setCapabilityKey] = React.useState("");
  const [capabilityLabel, setCapabilityLabel] = React.useState("");
  const [capabilityDescription, setCapabilityDescription] = React.useState("");
  const [capabilityError, setCapabilityError] = React.useState<string | null>(null);
  const [roleError, setRoleError] = React.useState<string | null>(null);
  const [denyError, setDenyError] = React.useState<string | null>(null);
  const [confirmAction, setConfirmAction] = React.useState<ConfirmAction | null>(
    null
  );

  React.useEffect(() => {
    if (selectedRoleKey && roles.some((role) => role.key === selectedRoleKey)) {
      return;
    }
    setSelectedRoleKey(roles[0]?.key ?? null);
  }, [roles, selectedRoleKey]);

  const commitPolicy = React.useCallback(
    (
      nextRoles: PolicyRole[],
      nextCaps = capabilities,
      nextAssignments = assignments,
      nextDenies = denies
    ) => {
      onChange({
        ...base,
        roles: nextRoles,
        capabilities: nextCaps,
        assignments: nextAssignments,
        denies: nextDenies,
      });
    },
    [base, onChange, capabilities, assignments, denies]
  );

  const updateRole = (roleKey: string, patch: Partial<PolicyRole>) => {
    const nextRoles = roles.map((role) =>
      role.key === roleKey ? { ...role, ...patch } : role
    );
    commitPolicy(nextRoles);
  };

  const addRole = () => {
    const key = newRoleKey.trim();
    if (!key) {
      setRoleError(t("roles.errors.required"));
      return;
    }
    if (roles.some((role) => role.key === key)) {
      setRoleError(t("roles.errors.duplicate"));
      return;
    }
    const label = newRoleLabel.trim() || key;
    const description = newRoleDescription.trim();
    const nextRoles = [
      ...roles,
      { key, label, description, capability_keys: [] },
    ];
    setRoleError(null);
    setNewRoleKey("");
    setNewRoleLabel("");
    setNewRoleDescription("");
    commitPolicy(nextRoles);
    setSelectedRoleKey(key);
  };

  const renameRole = (roleKey: string, nextKey: string) => {
    const trimmed = nextKey.trim();
    if (!trimmed || trimmed === roleKey) return;
    if (roles.some((role) => role.key === trimmed)) {
      setRoleError(t("roles.errors.duplicate"));
      return;
    }
    const nextRoles = roles.map((role) =>
      role.key === roleKey ? { ...role, key: trimmed } : role
    );
    const nextAssignments = replaceRoleKey(assignments, roleKey, trimmed);
    setRoleError(null);
    commitPolicy(nextRoles, capabilities, nextAssignments);
    setSelectedRoleKey(trimmed);
  };

  const deleteRole = (roleKey: string) => {
    const nextRoles = roles.filter((role) => role.key !== roleKey);
    const nextAssignments = removeRoleKey(assignments, roleKey);
    if (selectedRoleKey === roleKey) {
      setSelectedRoleKey(nextRoles[0]?.key ?? null);
    }
    commitPolicy(nextRoles, capabilities, nextAssignments);
  };

  const toggleCapability = (roleKey: string, capability: string) => {
    const nextRoles = roles.map((role) => {
      if (role.key !== roleKey) return role;
      const current = toUniqueStrings(role.capability_keys ?? []);
      const hasWildcard = current.includes("*");
      if (hasWildcard) {
        return { ...role, capability_keys: ["*"] };
      }
      const next = current.includes(capability)
        ? current.filter((key) => key !== capability)
        : [...current, capability];
      return { ...role, capability_keys: next };
    });
    commitPolicy(nextRoles);
  };

  const toggleWildcard = (roleKey: string) => {
    const nextRoles = roles.map((role) => {
      if (role.key !== roleKey) return role;
      const current = toUniqueStrings(role.capability_keys ?? []);
      const hasWildcard = current.includes("*");
      return { ...role, capability_keys: hasWildcard ? [] : ["*"] };
    });
    commitPolicy(nextRoles);
  };

  const addCapability = () => {
    const key = capabilityKey.trim();
    if (!key) {
      setCapabilityError(t("capabilities.errors.required"));
      return;
    }
    if (capabilities.some((cap) => cap.key === key)) {
      setCapabilityError(t("capabilities.errors.duplicate"));
      return;
    }
    const label = capabilityLabel.trim() || key;
    const description = capabilityDescription.trim();
    const nextCaps = [...capabilities, { key, label, description }];
    setCapabilityError(null);
    setCapabilityKey("");
    setCapabilityLabel("");
    setCapabilityDescription("");
    commitPolicy(roles, nextCaps);
  };

  const removeCapability = (capabilityKeyValue: string) => {
    const nextCaps = capabilities.filter((cap) => cap.key !== capabilityKeyValue);
    const nextRoles = roles.map((role) => {
      const current = toUniqueStrings(role.capability_keys ?? []);
      if (current.includes("*")) return role;
      const nextKeys = current.filter((key) => key !== capabilityKeyValue);
      return { ...role, capability_keys: nextKeys };
    });
    commitPolicy(nextRoles, nextCaps);
  };

  const updateDeny = (index: number, patch: Partial<PolicyDeny>) => {
    const nextDenies = denies.map((deny, denyIndex) =>
      denyIndex === index ? { ...deny, ...patch } : deny
    );
    commitPolicy(roles, capabilities, assignments, nextDenies);
  };

  const addDeny = () => {
    const capabilityKey = newDenyCapability.trim();
    const scopeType = newDenyScopeType.trim();
    const scopeId = newDenyScopeId.trim();
    const reason = newDenyReason.trim();
    if (!capabilityKey) {
      setDenyError(t("denies.errors.capabilityRequired"));
      return;
    }
    if (scopeId && !scopeType) {
      setDenyError(t("denies.errors.scopeTypeRequired"));
      return;
    }
    const nextDenies = [
      ...denies,
      {
        capability_key: capabilityKey,
        scope_type: scopeType || undefined,
        scope_id: scopeId || undefined,
        reason: reason || undefined,
      },
    ];
    setNewDenyCapability("");
    setNewDenyScopeType("");
    setNewDenyScopeId("");
    setNewDenyReason("");
    setDenyError(null);
    commitPolicy(roles, capabilities, assignments, nextDenies);
  };

  const removeDeny = (index: number) => {
    const nextDenies = denies.filter((_deny, denyIndex) => denyIndex !== index);
    commitPolicy(roles, capabilities, assignments, nextDenies);
  };

  const updateAssignment = (
    userType: string,
    roleKey: string,
    enabled: boolean
  ) => {
    const existing = assignments.user_type ?? {};
    const rolesForType = toUniqueStrings(existing[userType] ?? []);
    const nextRoles = enabled
      ? toUniqueStrings([...rolesForType, roleKey])
      : rolesForType.filter((key) => key !== roleKey);
    const nextAssignments = {
      ...assignments,
      user_type: {
        ...existing,
        [userType]: nextRoles,
      },
    };
    commitPolicy(roles, capabilities, nextAssignments);
  };

  const addUserType = () => {
    const key = newUserType.trim();
    if (!key) return;
    const existing = assignments.user_type ?? {};
    if (existing[key]) {
      setNewUserType("");
      return;
    }
    const nextAssignments = {
      ...assignments,
      user_type: { ...existing, [key]: [] },
    };
    setNewUserType("");
    commitPolicy(roles, capabilities, nextAssignments);
  };

  const removeUserType = (userType: string) => {
    const existing = assignments.user_type ?? {};
    const nextUserType = { ...existing };
    delete nextUserType[userType];
    const nextAssignments = {
      ...assignments,
      user_type: nextUserType,
    };
    commitPolicy(roles, capabilities, nextAssignments);
  };

  const addUserIdAssignment = () => {
    const userId = newUserId.trim();
    const roleKey = newUserIdRole.trim();
    if (!userId || !roleKey) return;
    const existing = assignments.user_id ?? {};
    const rolesForUser = toUniqueStrings(existing[userId] ?? []);
    const nextRoles = toUniqueStrings([...rolesForUser, roleKey]);
    const nextAssignments = {
      ...assignments,
      user_id: {
        ...existing,
        [userId]: nextRoles,
      },
    };
    setNewUserId("");
    setNewUserIdRole("");
    commitPolicy(roles, capabilities, nextAssignments);
  };

  const removeUserIdRole = (userId: string, roleKey: string) => {
    const existing = assignments.user_id ?? {};
    const nextRoles = (existing[userId] ?? []).filter((role) => role !== roleKey);
    const nextUserId = { ...existing };
    if (nextRoles.length > 0) {
      nextUserId[userId] = nextRoles;
    } else {
      delete nextUserId[userId];
    }
    const nextAssignments = {
      ...assignments,
      user_id: nextUserId,
    };
    commitPolicy(roles, capabilities, nextAssignments);
  };

  const confirmTitle = confirmAction
    ? confirmAction.type === "role"
      ? t("confirm.role.title", { label: confirmAction.label })
      : t("confirm.capability.title", { label: confirmAction.label })
    : "";
  const confirmDescription = confirmAction
    ? confirmAction.type === "role"
      ? t("confirm.role.description", { label: confirmAction.label })
      : t("confirm.capability.description", { label: confirmAction.label })
    : "";

  const handleConfirm = React.useCallback(() => {
    if (!confirmAction) return;
    if (confirmAction.type === "role") {
      deleteRole(confirmAction.key);
      return;
    }
    removeCapability(confirmAction.key);
  }, [confirmAction, deleteRole, removeCapability]);

  return (
    <div className="space-y-6" data-testid={`${testIdPrefix}-editor`}>
      <RoleCatalog
        t={t}
        roles={roles}
        capabilities={capabilities}
        selectedRoleKey={selectedRoleKey}
        onSelectRole={(key) => setSelectedRoleKey(key)}
        roleFilter={roleFilter}
        onRoleFilterChange={(value) => setRoleFilter(value)}
        capabilityFilter={capabilityFilter}
        onCapabilityFilterChange={(value) => setCapabilityFilter(value)}
        newRoleKey={newRoleKey}
        onNewRoleKeyChange={(value) => setNewRoleKey(value)}
        newRoleLabel={newRoleLabel}
        onNewRoleLabelChange={(value) => setNewRoleLabel(value)}
        newRoleDescription={newRoleDescription}
        onNewRoleDescriptionChange={(value) => setNewRoleDescription(value)}
        roleError={roleError}
        onAddRole={addRole}
        onUpdateRole={updateRole}
        onRenameRole={renameRole}
        onToggleWildcard={toggleWildcard}
        onToggleCapability={toggleCapability}
        onRemoveRole={(role) =>
          setConfirmAction({
            type: "role",
            key: role.key,
            label: role.label ?? role.key,
          })
        }
      />
      <CapabilityCatalog
        t={t}
        capabilities={capabilities}
        capabilityKey={capabilityKey}
        onCapabilityKeyChange={(value) => setCapabilityKey(value)}
        capabilityLabel={capabilityLabel}
        onCapabilityLabelChange={(value) => setCapabilityLabel(value)}
        capabilityDescription={capabilityDescription}
        onCapabilityDescriptionChange={(value) => setCapabilityDescription(value)}
        capabilityError={capabilityError}
        onAddCapability={addCapability}
        onRemoveCapability={(capability) =>
          setConfirmAction({
            type: "capability",
            key: capability.key,
            label: capability.label ?? capability.key,
          })
        }
      />
      <AssignmentsPanel
        t={t}
        assignments={assignments}
        roles={roles}
        newUserType={newUserType}
        onNewUserTypeChange={(value) => setNewUserType(value)}
        newUserId={newUserId}
        onNewUserIdChange={(value) => setNewUserId(value)}
        newUserIdRole={newUserIdRole}
        onNewUserIdRoleChange={(value) => setNewUserIdRole(value)}
        onAddUserType={addUserType}
        onRemoveUserType={removeUserType}
        onUpdateAssignment={updateAssignment}
        onAddUserIdAssignment={addUserIdAssignment}
        onRemoveUserIdRole={removeUserIdRole}
      />
      <DenyOverrides
        t={t}
        denies={denies}
        newDenyCapability={newDenyCapability}
        onNewDenyCapabilityChange={(value) => setNewDenyCapability(value)}
        newDenyScopeType={newDenyScopeType}
        onNewDenyScopeTypeChange={(value) => setNewDenyScopeType(value)}
        newDenyScopeId={newDenyScopeId}
        onNewDenyScopeIdChange={(value) => setNewDenyScopeId(value)}
        newDenyReason={newDenyReason}
        onNewDenyReasonChange={(value) => setNewDenyReason(value)}
        denyError={denyError}
        onAddDeny={addDeny}
        onUpdateDeny={updateDeny}
        onRemoveDeny={removeDeny}
      />

      <ConfirmDialog
        open={Boolean(confirmAction)}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        onConfirm={handleConfirm}
        title={confirmTitle}
        description={confirmDescription}
        confirmLabel={t("confirm.action")}
        cancelLabel={t("confirm.cancel")}
        tone="danger"
      />
    </div>
  );
}
