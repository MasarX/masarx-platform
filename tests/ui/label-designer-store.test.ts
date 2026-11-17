import {
  labelDesignerReducer,
  initialState,
  type LabelDesignerState,
  type LabelDesignerAction,
} from "../../packages/ui/src/label-designer/use-label-designer-store";

describe("label-designer store / reducer", () => {
  it("has correct initial state", () => {
    expect(initialState.bootLoading).toBe(true);
    expect(initialState.scopeLoading).toBe(false);
    expect(initialState.pageError).toBeNull();
    expect(initialState.organizationId).toBe("");
    expect(initialState.capabilities).toEqual([]);
    expect(initialState.drafts).toEqual([]);
    expect(initialState.assets).toEqual([]);
    expect(initialState.busyAction).toBeNull();
    expect(initialState.labelType).toBe("shipping");
  });

  it("SET_BOOT_LOADING", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_BOOT_LOADING",
      payload: false,
    });
    expect(next.bootLoading).toBe(false);
  });

  it("SET_SCOPE_LOADING", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_SCOPE_LOADING",
      payload: true,
    });
    expect(next.scopeLoading).toBe(true);
  });

  it("SET_PAGE_ERROR", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_PAGE_ERROR",
      payload: "Something went wrong",
    });
    expect(next.pageError).toBe("Something went wrong");
  });

  it("SET_BOOTSTRAP sets organization data and clears boot loading", () => {
    const action: LabelDesignerAction = {
      type: "SET_BOOTSTRAP",
      payload: {
        organizationId: "org-abc",
        capabilities: ["label_design.read", "label_design.write"],
        scopeOptions: [{ key: "tenant:org-abc", scopeType: "tenant", scopeId: "org-abc", label: "Tenant" }],
        selectedScopeKey: "tenant:org-abc",
        shipments: [{ id: "ship-1", label: "TRK001" }],
        selectedShipmentId: "ship-1",
      },
    };
    const next = labelDesignerReducer(initialState, action);
    expect(next.bootLoading).toBe(false);
    expect(next.organizationId).toBe("org-abc");
    expect(next.capabilities).toEqual(["label_design.read", "label_design.write"]);
    expect(next.scopeOptions).toHaveLength(1);
    expect(next.selectedScopeKey).toBe("tenant:org-abc");
    expect(next.shipments).toHaveLength(1);
    expect(next.selectedShipmentId).toBe("ship-1");
  });

  it("SET_SELECTED_SCOPE_KEY", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_SELECTED_SCOPE_KEY",
      payload: "client:cl-1",
    });
    expect(next.selectedScopeKey).toBe("client:cl-1");
  });

  it("SET_SCOPE_DATA sets configs and drafts, resets preview", () => {
    const state: LabelDesignerState = {
      ...initialState,
      previewResponseJson: '{"old": true}',
      samplePayloadJson: '{"sample": true}',
    };
    const action: LabelDesignerAction = {
      type: "SET_SCOPE_DATA",
      payload: {
        effectiveDesignJson: '{"design": true}',
        effectiveRenderPolicyJson: '{"policy": true}',
        effectivePrintProfileJson: '{"profile": true}',
        fieldCatalogJson: '{"fields": []}',
        mediaCatalogJson: '{"media": []}',
        drafts: [],
        selectedDraftId: "",
        draftName: "",
        labelType: "shipping",
        draftEditor: "{}",
      },
    };
    const next = labelDesignerReducer(state, action);
    expect(next.scopeLoading).toBe(false);
    expect(next.effectiveDesignJson).toBe('{"design": true}');
    expect(next.previewResponseJson).toBe("");
    expect(next.samplePayloadJson).toBe("");
  });

  it("SELECT_DRAFT sets draft fields and clears error", () => {
    const state: LabelDesignerState = {
      ...initialState,
      draftEditorError: "old error",
    };
    const next = labelDesignerReducer(state, {
      type: "SELECT_DRAFT",
      payload: {
        selectedDraftId: "draft-1",
        draftName: "Test Draft",
        labelType: "shipping",
        draftEditor: '{"blocks": []}',
      },
    });
    expect(next.selectedDraftId).toBe("draft-1");
    expect(next.draftName).toBe("Test Draft");
    expect(next.draftEditorError).toBeNull();
  });

  it("SET_DRAFT_NAME", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_DRAFT_NAME",
      payload: "New Name",
    });
    expect(next.draftName).toBe("New Name");
  });

  it("SET_LABEL_TYPE", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_LABEL_TYPE",
      payload: "return",
    });
    expect(next.labelType).toBe("return");
  });

  it("SET_DRAFT_EDITOR", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_DRAFT_EDITOR",
      payload: '{"blocks": [1]}',
    });
    expect(next.draftEditor).toBe('{"blocks": [1]}');
  });

  it("SET_DRAFT_EDITOR_ERROR", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_DRAFT_EDITOR_ERROR",
      payload: "Invalid JSON",
    });
    expect(next.draftEditorError).toBe("Invalid JSON");
  });

  it("SET_SELECTED_SHIPMENT_ID", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_SELECTED_SHIPMENT_ID",
      payload: "ship-2",
    });
    expect(next.selectedShipmentId).toBe("ship-2");
  });

  it("SET_SHIPMENT_BOXES", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_SHIPMENT_BOXES",
      payload: {
        shipmentBoxes: [{ id: "box-1", label: "Box 1" }],
        selectedShipmentBoxId: "box-1",
      },
    });
    expect(next.shipmentBoxes).toHaveLength(1);
    expect(next.selectedShipmentBoxId).toBe("box-1");
  });

  it("SET_SELECTED_SHIPMENT_BOX_ID", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_SELECTED_SHIPMENT_BOX_ID",
      payload: "box-5",
    });
    expect(next.selectedShipmentBoxId).toBe("box-5");
  });

  it("SET_SAMPLE_PAYLOAD", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_SAMPLE_PAYLOAD",
      payload: '{"payload": true}',
    });
    expect(next.samplePayloadJson).toBe('{"payload": true}');
  });

  it("SET_PREVIEW_RESPONSE", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_PREVIEW_RESPONSE",
      payload: '{"pdf_base64": "abc"}',
    });
    expect(next.previewResponseJson).toBe('{"pdf_base64": "abc"}');
  });

  it("SET_ASSETS", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_ASSETS",
      payload: {
        assets: [{ name: "logo.png", path: "org/logo.png" }],
        assetsError: null,
      },
    });
    expect(next.assets).toHaveLength(1);
    expect(next.assetsError).toBeNull();
  });

  it("SET_ASSETS with error", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_ASSETS",
      payload: {
        assets: [],
        assetsError: "Failed to load",
      },
    });
    expect(next.assets).toEqual([]);
    expect(next.assetsError).toBe("Failed to load");
  });

  it("SET_BUSY", () => {
    const next = labelDesignerReducer(initialState, {
      type: "SET_BUSY",
      payload: "save-draft",
    });
    expect(next.busyAction).toBe("save-draft");

    const cleared = labelDesignerReducer(next, {
      type: "SET_BUSY",
      payload: null,
    });
    expect(cleared.busyAction).toBeNull();
  });

  it("returns unchanged state for unknown action", () => {
    const next = labelDesignerReducer(initialState, { type: "UNKNOWN" } as unknown as LabelDesignerAction);
    expect(next).toBe(initialState);
  });
});
