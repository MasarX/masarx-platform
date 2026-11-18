function sanitizeTestIdSegment(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export function mobileModuleTestId(moduleKey: string) {
  return `mobile-module-${sanitizeTestIdSegment(moduleKey)}`;
}

export function mobileActionTestId(actionKey: string) {
  return `mobile-action-${sanitizeTestIdSegment(actionKey)}`;
}

export function mobileComposerFieldTestId(fieldKey: string) {
  return `mobile-action-composer-field-${sanitizeTestIdSegment(fieldKey)}`;
}

export function mobileComposerFieldLabelTestId(fieldKey: string) {
  return `${mobileComposerFieldTestId(fieldKey)}-label`;
}

export function mobileComposerFieldInputTestId(fieldKey: string) {
  return `${mobileComposerFieldTestId(fieldKey)}-input`;
}

export function mobileComposerFieldOptionsTestId(fieldKey: string) {
  return `${mobileComposerFieldTestId(fieldKey)}-options`;
}

export function mobileComposerFieldOptionTestId(fieldKey: string, optionValue: string) {
  return `${mobileComposerFieldTestId(fieldKey)}-option-${sanitizeTestIdSegment(optionValue)}`;
}

export function mobileComposerFieldSelectedValueTestId(fieldKey: string) {
  return `${mobileComposerFieldTestId(fieldKey)}-selected-value`;
}

export function mobileComposerFieldStatusTestId(fieldKey: string) {
  return `${mobileComposerFieldTestId(fieldKey)}-status`;
}

export function mobileScanTypeOptionTestId(scanType: string) {
  return `mobile-scan-type-option-${sanitizeTestIdSegment(scanType)}`;
}

export function mobileScanInputModeOptionTestId(inputMode: string) {
  return `mobile-scan-input-mode-${sanitizeTestIdSegment(inputMode)}`;
}

export function mobileOutboxEntryTestId(entryId: string) {
  return `mobile-outbox-entry-${sanitizeTestIdSegment(entryId)}`;
}

export const MOBILE_TEST_IDS = {
  auth: {
    form: "mobile-signin-form",
    emailInput: "mobile-signin-email",
    passwordInput: "EXAMPLE_PASSWORD",
    otpInput: "mobile-signin-otp",
    submitButton: "mobile-signin-submit",
    errorMessage: "mobile-signin-error",
  },
  shell: {
    ready: "mobile-shell-ready",
    menuToggle: "mobile-menu-toggle",
    menuClose: "mobile-menu-close",
    connectivityBanner: "mobile-connectivity-banner",
    headerOutboxCount: "mobile-header-outbox-count",
  },
  module: {
    tasks: mobileModuleTestId("tasks"),
    route: mobileModuleTestId("route"),
    scan: mobileModuleTestId("scan"),
    location: mobileModuleTestId("location"),
    outbox: mobileModuleTestId("outbox"),
    settlements: mobileModuleTestId("settlements"),
    more: mobileModuleTestId("more"),
  },
  more: {
    shiftStatus: "mobile-driver-shift-status",
    startShift: "mobile-start-driver-shift",
    endShift: "mobile-end-driver-shift",
    openDiagnostics: "mobile-open-diagnostics",
  },
  route: {
    screen: "mobile-route-screen",
    status: "mobile-route-status",
    sync: "mobile-route-sync",
  },
  outbox: {
    screen: "mobile-outbox-screen",
    pendingCount: "mobile-outbox-pending-count",
    sync: "mobile-outbox-sync",
    clearDead: "mobile-outbox-clear-dead",
    clearAll: "mobile-outbox-clear-all",
    empty: "mobile-outbox-empty",
  },
  diagnostics: {
    screen: "mobile-diagnostics-screen",
  },
  composer: {
    close: "mobile-action-composer-close",
    queue: "mobile-action-composer-queue",
    error: "mobile-action-composer-error",
    proofSummary: "mobile-action-composer-proof-summary",
    proofPolicyStatus: "mobile-action-composer-proof-policy-status",
    proofArtifactStatus: "mobile-action-composer-proof-artifact-status",
    proofSignatureStatus: "mobile-action-composer-proof-signature-status",
    proofOtpStatus: "mobile-action-composer-proof-otp-status",
    proofIdentityStatus: "mobile-action-composer-proof-identity-status",
    signatureStatus: "mobile-action-composer-signature-status",
  },
  scan: {
    screen: "mobile-scan-screen",
    sync: "mobile-scan-sync",
    barcodeInput: "mobile-scan-barcode-input",
    context: "mobile-scan-context",
    lastQueued: "mobile-scan-last-queued",
    queue: "mobile-scan-queue",
    toggleCamera: "mobile-scan-toggle-camera",
    typeSelection: "mobile-scan-type-selection",
    selectedType: "mobile-scan-selected-type",
  },
} as const;
