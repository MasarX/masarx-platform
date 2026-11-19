// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type { MobileV2RoleOption } from "../mobile-v2-role-select-screen";

export const MOBILE_V2_PREVIEW_ROLES_PICKER: {
  readonly availableRoles: ReadonlyArray<MobileV2RoleOption>;
  readonly selectedRoleId: string | null;
  readonly employeeId: string;
  readonly displayName: string;
} = Object.freeze({
  availableRoles: Object.freeze([
    Object.freeze({
      id: "driver",
      icon: "truck" as const,
      title: "Driver",
      sub: "On-route delivery, POD, COD, returns",
    }),
    Object.freeze({
      id: "loader",
      icon: "package" as const,
      title: "Warehouse loader",
      sub: "Scan-out, manifest reconciliation",
    }),
  ]),
  // Design canvas s-role-select artboard captures the initial unselected
  // state: both role rows show the trailing chevron, no "Selected" chip,
  // and the CTA is in soft variant. Production cutover resolves this from
  // the user's persisted role preference via the role-select policy.
  selectedRoleId: null,
  employeeId: "DRV-2041",
  displayName: "Omar Al-Saadi",
});
