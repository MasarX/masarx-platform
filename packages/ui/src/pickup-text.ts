import { createUiTranslator } from "./i18n";

// Separate from pickup-page-shared so callers that mock that module still get real text.
export function pickupKindLabel(kind: "client" | "sender" | "branch" | "driver" | "vehicle" | "shipment" | "reference") {
  return createUiTranslator("ui.pickupOperations.kinds")(kind);
}

export function pickupErrorText(key: string, values?: Record<string, string>) {
  return createUiTranslator("ui.pickupOperations.errors")(key, values);
}
