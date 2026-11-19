export type MobileV2RuntimeBlockerKind =
  | "configuration"
  | "clientCredential"
  | "mobileV2Unavailable";

export type MobileV2RuntimeBlockerCopy = {
  readonly title: string;
  readonly heading: string;
  readonly message: string;
  readonly actionLabel: string;
};

export function resolveMobileV2RuntimeBlockerCopy(input: {
  readonly kind: MobileV2RuntimeBlockerKind;
  readonly appName?: string | null;
}): MobileV2RuntimeBlockerCopy {
  const title = input.appName?.trim() || "FieldOps";
  if (input.kind === "clientCredential") {
    return {
      title,
      heading: "Workspace connection needs attention",
      message:
        "This app cannot start with the current workspace connection. Ask your MasarX administrator to publish the FieldOps mobile client configuration, then restart the app.",
      actionLabel: "Restart after update",
    };
  }
  if (input.kind === "mobileV2Unavailable") {
    return {
      title,
      heading: "FieldOps Mobile V2 is not available",
      message:
        "Mobile V2 could not be confirmed for this account. Check the device connection or ask an operator to enable this tenant, then retry.",
      actionLabel: "Retry",
    };
  }
  return {
    title,
    heading: "Setup needed before FieldOps can start",
    message:
      "This app is missing required workspace connection settings. Ask your MasarX administrator to update the FieldOps mobile configuration, then restart the app.",
    actionLabel: "Restart after update",
  };
}
