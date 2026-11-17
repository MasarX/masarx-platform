import type { useTranslations } from "next-intl";

export type JsonRecord = Record<string, unknown>;

export type PolicyCapability = JsonRecord & {
  key: string;
  label?: string;
  description?: string;
};

export type PolicyRole = JsonRecord & {
  key: string;
  label?: string;
  description?: string;
  capability_keys?: string[];
};

export type PolicyAssignments = {
  user_type?: Record<string, string[]>;
  user_id?: Record<string, string[]>;
};

export type PolicyDeny = JsonRecord & {
  capability_key: string;
  scope_type?: string;
  scope_id?: string;
  reason?: string;
};

export type NormalizedPolicy = {
  base: JsonRecord;
  capabilities: PolicyCapability[];
  roles: PolicyRole[];
  assignments: PolicyAssignments;
  denies: PolicyDeny[];
};

export type AccessPolicyTranslator = ReturnType<typeof useTranslations>;
