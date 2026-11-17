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
});
