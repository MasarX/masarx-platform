import * as React from "react";
import type { AssetItem, DraftRow, ScopeOption, ShipmentBoxOption, ShipmentOption } from "./types";

export type LabelDesignerState = {
  bootLoading: boolean;
  scopeLoading: boolean;
  pageError: string | null;

  organizationId: string;
  capabilities: string[];

  scopeOptions: ScopeOption[];
  selectedScopeKey: string;

  effectiveDesignJson: string;
  effectiveRenderPolicyJson: string;
  effectivePrintProfileJson: string;
  fieldCatalogJson: string;
  mediaCatalogJson: string;

  drafts: DraftRow[];
  selectedDraftId: string;
  draftName: string;
  labelType: string;
  draftEditor: string;
  draftEditorError: string | null;

  shipments: ShipmentOption[];
  selectedShipmentId: string;
  shipmentBoxes: ShipmentBoxOption[];
  selectedShipmentBoxId: string;

  samplePayloadJson: string;
  previewResponseJson: string;

  assets: AssetItem[];
  assetsError: string | null;

  busyAction: string | null;
};

export const initialState: LabelDesignerState = {
  bootLoading: true,
  scopeLoading: false,
  pageError: null,

  organizationId: "",
  capabilities: [],

  scopeOptions: [],
  selectedScopeKey: "",

  effectiveDesignJson: "{}",
  effectiveRenderPolicyJson: "{}",
  effectivePrintProfileJson: "{}",
  fieldCatalogJson: "{}",
  mediaCatalogJson: "{}",

  drafts: [],
  selectedDraftId: "",
  draftName: "",
  labelType: "shipping",
  draftEditor: "{}",
  draftEditorError: null,

  shipments: [],
  selectedShipmentId: "",
  shipmentBoxes: [],
  selectedShipmentBoxId: "",

  samplePayloadJson: "",
  previewResponseJson: "",

  assets: [],
  assetsError: null,

  busyAction: null,
};

export type LabelDesignerAction =
  | { type: "SET_BOOT_LOADING"; payload: boolean }
  | { type: "SET_SCOPE_LOADING"; payload: boolean }
  | { type: "SET_PAGE_ERROR"; payload: string | null }
  | { type: "SET_BOOTSTRAP"; payload: {
      organizationId: string;
      capabilities: string[];
      scopeOptions: ScopeOption[];
      selectedScopeKey: string;
      shipments: ShipmentOption[];
      selectedShipmentId: string;
    }}
  | { type: "SET_SELECTED_SCOPE_KEY"; payload: string }
  | { type: "SET_SCOPE_DATA"; payload: {
      effectiveDesignJson: string;
      effectiveRenderPolicyJson: string;
      effectivePrintProfileJson: string;
      fieldCatalogJson: string;
      mediaCatalogJson: string;
      drafts: DraftRow[];
      selectedDraftId: string;
      draftName: string;
      labelType: string;
      draftEditor: string;
    }}
  | { type: "SELECT_DRAFT"; payload: {
      selectedDraftId: string;
      draftName: string;
      labelType: string;
      draftEditor: string;
    }}
  | { type: "SET_DRAFT_NAME"; payload: string }
  | { type: "SET_LABEL_TYPE"; payload: string }
  | { type: "SET_DRAFT_EDITOR"; payload: string }
  | { type: "SET_DRAFT_EDITOR_ERROR"; payload: string | null }
  | { type: "SET_SELECTED_SHIPMENT_ID"; payload: string }
  | { type: "SET_SHIPMENT_BOXES"; payload: {
      shipmentBoxes: ShipmentBoxOption[];
      selectedShipmentBoxId: string;
    }}
  | { type: "SET_SELECTED_SHIPMENT_BOX_ID"; payload: string }
  | { type: "SET_SAMPLE_PAYLOAD"; payload: string }
  | { type: "SET_PREVIEW_RESPONSE"; payload: string }
  | { type: "SET_ASSETS"; payload: { assets: AssetItem[]; assetsError: string | null } }
  | { type: "SET_BUSY"; payload: string | null };

export function labelDesignerReducer(
  state: LabelDesignerState,
  action: LabelDesignerAction,
): LabelDesignerState {
  switch (action.type) {
    case "SET_BOOT_LOADING":
      return { ...state, bootLoading: action.payload };
    case "SET_SCOPE_LOADING":
      return { ...state, scopeLoading: action.payload };
    case "SET_PAGE_ERROR":
      return { ...state, pageError: action.payload };
    case "SET_BOOTSTRAP":
      return {
        ...state,
        bootLoading: false,
        organizationId: action.payload.organizationId,
        capabilities: action.payload.capabilities,
        scopeOptions: action.payload.scopeOptions,
        selectedScopeKey: action.payload.selectedScopeKey,
        shipments: action.payload.shipments,
        selectedShipmentId: action.payload.selectedShipmentId,
      };
    case "SET_SELECTED_SCOPE_KEY":
      return { ...state, selectedScopeKey: action.payload };
    case "SET_SCOPE_DATA":
      return {
        ...state,
        scopeLoading: false,
        effectiveDesignJson: action.payload.effectiveDesignJson,
        effectiveRenderPolicyJson: action.payload.effectiveRenderPolicyJson,
        effectivePrintProfileJson: action.payload.effectivePrintProfileJson,
        fieldCatalogJson: action.payload.fieldCatalogJson,
        mediaCatalogJson: action.payload.mediaCatalogJson,
        drafts: action.payload.drafts,
        selectedDraftId: action.payload.selectedDraftId,
        draftName: action.payload.draftName,
        labelType: action.payload.labelType,
        draftEditor: action.payload.draftEditor,
        previewResponseJson: "",
        samplePayloadJson: "",
      };
    case "SELECT_DRAFT":
      return {
        ...state,
        selectedDraftId: action.payload.selectedDraftId,
        draftName: action.payload.draftName,
        labelType: action.payload.labelType,
        draftEditor: action.payload.draftEditor,
        draftEditorError: null,
      };
    case "SET_DRAFT_NAME":
      return { ...state, draftName: action.payload };
    case "SET_LABEL_TYPE":
      return { ...state, labelType: action.payload };
    case "SET_DRAFT_EDITOR":
      return { ...state, draftEditor: action.payload };
    case "SET_DRAFT_EDITOR_ERROR":
      return { ...state, draftEditorError: action.payload };
    case "SET_SELECTED_SHIPMENT_ID":
      return { ...state, selectedShipmentId: action.payload };
    case "SET_SHIPMENT_BOXES":
      return {
        ...state,
        shipmentBoxes: action.payload.shipmentBoxes,
        selectedShipmentBoxId: action.payload.selectedShipmentBoxId,
      };
    case "SET_SELECTED_SHIPMENT_BOX_ID":
      return { ...state, selectedShipmentBoxId: action.payload };
    case "SET_SAMPLE_PAYLOAD":
      return { ...state, samplePayloadJson: action.payload };
    case "SET_PREVIEW_RESPONSE":
      return { ...state, previewResponseJson: action.payload };
    case "SET_ASSETS":
      return { ...state, assets: action.payload.assets, assetsError: action.payload.assetsError };
    case "SET_BUSY":
      return { ...state, busyAction: action.payload };
    default:
      return state;
  }
}

export function useLabelDesignerStore() {
  return React.useReducer(labelDesignerReducer, initialState);
}
