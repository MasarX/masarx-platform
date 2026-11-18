import React from "react";
import { revalidatePath } from "next/cache";
import { createServerClient } from "@masarx/auth/server";
import { ShipmentAmendCancelPage } from "../../packages/ui/src/shipment-amend-cancel-page";
import { ShipmentAmendCancelForm } from "../../packages/ui/src/shipment-amend-cancel-form";

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

jest.mock("@masarx/auth/server", () => ({
  createServerClient: jest.fn(),
}));

jest.mock("../../packages/ui/src/shipment-amend-cancel-form", () => {
  const actual = jest.requireActual("../../packages/ui/src/shipment-amend-cancel-form");
  return {
    ...actual,
    ShipmentAmendCancelForm: jest.fn(() => null),
  };
});

function findElement(
  node: React.ReactNode,
  predicate: (element: React.ReactElement) => boolean,
): React.ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  return findElement((node.props as { children?: React.ReactNode }).children ?? null, predicate);
}

describe("ShipmentAmendCancelPage", () => {
  const createServerClientMock = createServerClient as jest.Mock;
  const revalidatePathMock = revalidatePath as jest.Mock;
  const ShipmentAmendCancelFormMock = ShipmentAmendCancelForm as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("loads options and submits amend/cancel RPCs through the api schema", async () => {
    const rpcMock = jest.fn(async (name: string) => {
      if (name === "shipment_amend_cancel_options_v1") {
        return {
          data: {
            current_values: {
              tracking_number: "TRK-123",
              status: "pending",
              address_country: "AE",
            },
            operations: {
              cancel: { allowed: true, allowed_statuses: ["pending"], window_hours: 24 },
            },
            policy: { delete_window_hours: 24, address_default_country_code: "AE" },
          },
          error: null,
        };
      }
      if (name === "shipment_amend_cancel_v1") {
        return {
          data: { ok: true, workflow_status: "completed", shipment_action_id: "action-1" },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const schemaMock = jest.fn(() => ({ rpc: rpcMock }));
    createServerClientMock.mockReturnValue({ schema: schemaMock });

    const tree = await ShipmentAmendCancelPage({
      appKey: "portal",
      appBasePath: "/portal",
      baseHref: "/portal/operations/shipment-amend-cancel",
      searchParams: { shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830" },
      testIdPrefix: "portal-shipment-amend-cancel",
    });

    expect(createServerClientMock).toHaveBeenCalledWith({ allowCookieSet: false });
    expect(schemaMock).toHaveBeenCalledWith("api");
    expect(rpcMock).toHaveBeenCalledWith("shipment_amend_cancel_options_v1", {
      p_shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
    });

    const formElement = findElement(tree, (element) => element.type === ShipmentAmendCancelFormMock);
    expect(formElement).toBeTruthy();

    const action = formElement?.props.action as
      | ((prevState: { status: string }, formData: FormData) => Promise<{ status: string; message?: string }>)
      | undefined;
    expect(action).toEqual(expect.any(Function));

    const formData = new FormData();
    formData.set("shipment_id", "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830");
    formData.set("operation", "cancel");
    formData.set("cancel_reason", "customer request");

    await expect(action!({ status: "idle" }, formData)).resolves.toEqual(
      expect.objectContaining({ status: "success" }),
    );
    expect(schemaMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).toHaveBeenCalledWith("shipment_amend_cancel_v1", {
      p_input: expect.objectContaining({
        shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830",
        operation: "cancel",
        surface: "portal",
        reason: "customer request",
      }),
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/portal/operations/shipment-amend-cancel");
  });

  it("reports a queued workflow as a successful submission", async () => {
    const rpcMock = jest.fn(async (name: string) => {
      if (name === "shipment_amend_cancel_options_v1") {
        return {
          data: {
            current_values: { tracking_number: "TRK-QUEUED", status: "pending" },
            operations: {
              cancel: { allowed: true, allowed_statuses: ["pending"], window_hours: 24 },
            },
          },
          error: null,
        };
      }
      if (name === "shipment_amend_cancel_v1") {
        return {
          data: {
            ok: true,
            workflow_status: "in_progress",
            workflow_run_id: "run-queued",
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const schemaMock = jest.fn(() => ({ rpc: rpcMock }));
    createServerClientMock.mockReturnValue({ schema: schemaMock });

    const tree = await ShipmentAmendCancelPage({
      appKey: "portal",
      appBasePath: "/portal",
      baseHref: "/portal/operations/shipment-amend-cancel",
      searchParams: { shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830" },
      testIdPrefix: "portal-shipment-amend-cancel",
    });
    const formElement = findElement(tree, (element) => element.type === ShipmentAmendCancelFormMock);
    const action = formElement?.props.action as
      | ((prevState: { status: string }, formData: FormData) => Promise<{ status: string; message?: string }>)
      | undefined;
    const formData = new FormData();
    formData.set("shipment_id", "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830");
    formData.set("operation", "cancel");
    formData.set("cancel_reason", "customer request");

    await expect(action!({ status: "idle" }, formData)).resolves.toEqual({
      status: "success",
      message: "Shipment change queued in workflow run run-queued.",
      locked: true,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/portal/operations/shipment-amend-cancel");
  });
  it.each([
    ["completed", "verified", "success"],
    ["completed", "pending", "error"],
    ["in_progress", "pending", "success"],
    ["failed", "verified", "error"],
  ])("checks address capture for %s / %s", async (workflowStatus, captureStatus, expectedStatus) => {
    const rpcMock = jest.fn(async (name: string) => ({
      data: name === "shipment_amend_cancel_options_v1"
        ? { operations: { address: { allowed: true } }, current_values: {} }
        : { ok: true, workflow_status: workflowStatus, workflow_run_id: "run-address",
            destination_address_capture: { status: captureStatus, address_id: "address-1",
              sa_short_code: "ABCD1234", coordinates: { latitude: 24.7, longitude: 46.6 } } },
      error: null,
    }));
    createServerClientMock.mockReturnValue({ schema: jest.fn(() => ({ rpc: rpcMock })) });
    const tree = await ShipmentAmendCancelPage({
      appKey: "console", appBasePath: "/console", baseHref: "/console/operations/shipment-amend-cancel",
      searchParams: { shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830" }, testIdPrefix: "amend",
    });
    const form = findElement(tree, (element) => element.type === ShipmentAmendCancelFormMock);
    const data = new FormData();
    Object.entries({ shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", operation: "address",
      line1: "Street", city: "Riyadh", country: "SA", sa_short_code: " abcd1234 ", latitude: "24.7", longitude: "46.6",
    }).forEach(([key, value]) => data.set(key, value));
    const result = await form?.props.action({ status: "idle" }, data);
    expect(result.status).toBe(expectedStatus);
    if (workflowStatus === "in_progress") {
      expect(result.message).toContain("queued");
      expect(result.locked).toBe(true);
    }
    expect(rpcMock).toHaveBeenLastCalledWith("shipment_amend_cancel_v1", { p_input: expect.objectContaining({
      address: expect.objectContaining({ sa_short_code: "ABCD1234", latitude: 24.7, longitude: 46.6,
        coordinates: { latitude: 24.7, longitude: 46.6 } }),
    }) });
    if (expectedStatus === "error") expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("rejects an incomplete address coordinate pair before the mutation RPC", async () => {
    const rpcMock = jest.fn().mockResolvedValue({ data: { operations: { address: { allowed: true } } }, error: null });
    createServerClientMock.mockReturnValue({ schema: jest.fn(() => ({ rpc: rpcMock })) });
    const tree = await ShipmentAmendCancelPage({
      appKey: "console", appBasePath: "/console", baseHref: "/console/operations/shipment-amend-cancel",
      searchParams: { shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830" }, testIdPrefix: "amend",
    });
    const form = findElement(tree, (element) => element.type === ShipmentAmendCancelFormMock);
    const data = new FormData();
    Object.entries({ shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", operation: "address",
      line1: "Street", city: "Riyadh", country: "SA", latitude: "24",
    }).forEach(([key, value]) => data.set(key, value));
    expect(await form?.props.action({ status: "idle" }, data)).toEqual({
      status: "error", message: "Enter both latitude and longitude.",
    });
    expect(rpcMock).toHaveBeenCalledTimes(2);
    expect(rpcMock).not.toHaveBeenCalledWith("shipment_amend_cancel_v1", expect.anything());
  });

  it.each([
    ["stale field permission", [], { allowed: true }],
    ["missing field policy", undefined, { allowed: true }],
    ["null field policy", null, { allowed: true }],
    ["malformed field policy", "service_type", { allowed: true }],
    ["untrimmed field permission", [" service_type "], { allowed: true }],
    ["missing operation", ["service_type"], undefined],
    ["blocked operation", ["service_type"], { allowed: false, reason: "shipment_status_not_allowed" }],
  ] as Array<[string, unknown, unknown]>)("rejects %s before mutation despite rendered permission", async (_name, fields, operationState) => {
    let actionRead = false;
    const rpcMock = jest.fn(async (name: string) => ({
      data: name === "shipment_amend_cancel_options_v1"
        ? { operations: { modify: actionRead ? operationState : { allowed: true } },
            policy: { modify_allowed_fields: actionRead ? fields : ["service_type"] } }
        : { ok: true, workflow_status: "completed" },
      error: null,
    }));
    createServerClientMock.mockReturnValue({ schema: jest.fn(() => ({ rpc: rpcMock })) });
    const tree = await ShipmentAmendCancelPage({
      appKey: "console", appBasePath: "/console", baseHref: "/console/operations/shipment-amend-cancel",
      searchParams: { shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830" }, testIdPrefix: "policy",
    });
    actionRead = true;
    const form = findElement(tree, (element) => element.type === ShipmentAmendCancelFormMock);
    const data = new FormData();
    data.set("shipment_id", "22222222-2222-4222-8222-222222222222");
    data.set("operation", "modify");
    data.set("service_type", "delivery");
    const result = await form?.props.action({ status: "idle" }, data);
    expect(result.status).toBe("error");
    expect(result.message).toContain("shipment_operation_policy");
    expect(result.locked).not.toBe(true);
    expect(rpcMock).toHaveBeenLastCalledWith("shipment_amend_cancel_options_v1", {
      p_shipment_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(rpcMock).not.toHaveBeenCalledWith("shipment_amend_cancel_v1", expect.anything());
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it.each([
    ["service_type", "service_type", "delivery", "delivery"],
    ["service_level", "service_level", "express", "express"],
    ["client_reference_number", "client_reference_number", "client-ref", "client-ref"],
    ["carrier_reference_number", "carrier_reference_number", "carrier-ref", "carrier-ref"],
    ["special_instructions", "special_instructions", "Leave safely", "Leave safely"],
    ["cod_amount", "cod_amount", "12.50", "12.50"],
    ["metadata_json", "metadata", '{"priority":"vip"}', { priority: "vip" }],
    ["references_json", "references", '{"external":["REF"]}', { external: ["REF"] }],
  ] as Array<[string, string, string, unknown]>)("submits only the allowed %s field using current mapping", async (formField, policyField, value, expected) => {
    const rpcMock = jest.fn(async (name: string) => ({
      data: name === "shipment_amend_cancel_options_v1"
        ? { operations: { modify: { allowed: true } }, policy: { modify_allowed_fields: [policyField] } }
        : { ok: true, workflow_status: "completed" },
      error: null,
    }));
    createServerClientMock.mockReturnValue({ schema: jest.fn(() => ({ rpc: rpcMock })) });
    const tree = await ShipmentAmendCancelPage({
      appKey: "console", appBasePath: "/console", baseHref: "/console/operations/shipment-amend-cancel",
      searchParams: { shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830" }, testIdPrefix: "policy",
    });
    const form = findElement(tree, (element) => element.type === ShipmentAmendCancelFormMock);
    const data = new FormData();
    data.set("shipment_id", "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830");
    data.set("operation", "modify");
    data.set(formField, value);
    expect(await form?.props.action({ status: "idle" }, data)).toMatchObject({ status: "success" });
    expect(rpcMock).toHaveBeenLastCalledWith("shipment_amend_cancel_v1", { p_input: {
      shipment_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", operation: "modify", surface: "console",
      changes: { [policyField]: expected },
    } });
  });

});
