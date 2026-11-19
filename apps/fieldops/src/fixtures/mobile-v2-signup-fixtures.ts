// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2SignupRoleOption,
  MobileV2SignupStep,
} from "../mobile-v2-signup-screen";

export const MOBILE_V2_PREVIEW_SIGNUP_ROLES: ReadonlyArray<MobileV2SignupRoleOption> =
  Object.freeze([
    Object.freeze({
      id: "driver",
      icon: "truck" as const,
      label: "Driver",
      sub: "On-route delivery, POD, COD",
    }),
    Object.freeze({
      id: "loader",
      icon: "package" as const,
      label: "Warehouse loader",
      sub: "Scan-out, manifest reconciliation",
    }),
  ]);

export const MOBILE_V2_PREVIEW_SIGNUP: {
  readonly step: MobileV2SignupStep;
  readonly phone: string;
  readonly otp: string;
  readonly name: string;
  readonly employeeId: string;
  readonly selectedRoleIds: ReadonlyArray<string>;
  readonly errorMessage: string | null;
  readonly autoFillHint: string;
  readonly roleOptions: ReadonlyArray<MobileV2SignupRoleOption>;
} = Object.freeze({
  step: "phone",
  phone: "+966 ",
  otp: "",
  name: "",
  employeeId: "",
  selectedRoleIds: Object.freeze(["driver"]),
  errorMessage: null,
  autoFillHint: "Auto-fill in 1.2s",
  roleOptions: MOBILE_V2_PREVIEW_SIGNUP_ROLES,
});
