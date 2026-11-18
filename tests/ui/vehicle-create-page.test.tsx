jest.mock("server-only", () => ({}));
jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
import { createUiServerClient } from "@masarx/api/server";
import { VehicleCreatePage } from "../../packages/ui/src/vehicle-create-page";

const factory = createUiServerClient as jest.Mock;
const org = "57140461-2e69-4c86-8140-011ec18f7c01";
const other = "57140461-2e69-4c86-8140-011ec18f7c02";
const schema = { type: "object", additionalProperties: false, required: ["plate_number"], properties: { plate_number: { type: "string", minLength: 4 } } };
const identity = { user: { id: "actor-a" }, org: { id: org }, access_scope: { scope_type: "tenant", scope_id: null }, capabilities: ["fleet.read", "fleet.write"] };
const command = { key: "vehicles.create", label: "New vehicle", capability: "fleet.write", schema_category: "vehicle_create_form_v1" };

describe("VehicleCreatePage server submission", () => {
  let ui: any;
  beforeEach(() => {
    jest.resetAllMocks();
    ui = { me: jest.fn().mockResolvedValue(identity), commandRegistry: jest.fn().mockResolvedValue({ commands: [command] }),
      listResource: jest.fn().mockResolvedValue({ items: [{ schema }] }), getResource: jest.fn().mockResolvedValue({ id: other }),
      rpc: jest.fn().mockResolvedValue({ ok: true, vehicle_id: "created", organization_id: org }) };
    factory.mockReturnValue(ui);
  });
  async function action() {
    const page: any = await VehicleCreatePage({ testIdPrefix: "console-vehicle-create" });
    return page.props.children[1].props.children.props.submitAction;
  }
  it("validates current row-driven schema on the server and emits only safe create result", async () => {
    const submit = await action();
    expect(await submit(org, {})).toEqual({ ok: false });
    expect(await submit(org, { plate_number: "ABC" })).toEqual({ ok: false });
    expect(await submit(org, { plate_number: "ABCD", organization_id: other })).toEqual({ ok: false });
    expect(ui.rpc).not.toHaveBeenCalled();
    expect(await submit(org, { plate_number: "ABCD" })).toEqual({ ok: true, vehicle_id: "created", organization_id: org });
    expect(ui.rpc).toHaveBeenCalledTimes(1);
    expect(ui.rpc).toHaveBeenCalledWith("create_vehicle_v1", { p_args: { plate_number: "ABCD", organization_id: org } }, { retries: 0 });
  });
  it("publishes ready, blocked, and error coverage states", async () => {
    expect((await VehicleCreatePage({ testIdPrefix: "console-vehicle-create" }) as any).props["data-testid"])
      .toBe("console-vehicle-create-ready");

    ui.me.mockResolvedValue({ ...identity, capabilities: [] });
    expect((await VehicleCreatePage({ testIdPrefix: "console-vehicle-create" }) as any).props["data-testid"])
      .toBe("console-vehicle-create-blocked");

    ui.me.mockRejectedValue(new Error("private-error-sentinel"));
    expect((await VehicleCreatePage({ testIdPrefix: "console-vehicle-create" }) as any).props["data-testid"])
      .toBe("console-vehicle-create-error");
  });
  it("rechecks actor, scope and capabilities instead of trusting initial render", async () => {
    const submit = await action();
    ui.me.mockResolvedValue({ ...identity, user: { id: "actor-b" } });
    expect(await submit(org, { plate_number: "ABCD" })).toEqual({ ok: false });
    ui.me.mockResolvedValue({ ...identity, capabilities: [] });
    expect(await submit(org, { plate_number: "ABCD" })).toEqual({ ok: false });
    ui.me.mockResolvedValue({ ...identity, org: { id: other } });
    expect(await submit(org, { plate_number: "ABCD" })).toEqual({ ok: false });
    expect(ui.rpc).not.toHaveBeenCalled();
  });
  it("fails closed on changed or malformed schema without leaking validator errors", async () => {
    const submit = await action();
    ui.listResource.mockResolvedValue({ items: [{ schema: { type: "not-a-type" } }] });
    expect(await submit(org, { plate_number: "ABCD" })).toEqual({ ok: false });
    ui.listResource.mockRejectedValue(new Error("private-error-sentinel"));
    expect(await submit(org, { plate_number: "ABCD" })).toEqual({ ok: false });
    expect(ui.rpc).not.toHaveBeenCalled();
  });
  it("revalidates a platform-selected target through the existing organizations reader", async () => {
    ui.me.mockResolvedValue({ ...identity, access_scope: { scope_type: "platform", scope_id: null }, capabilities: [...identity.capabilities, "organizations.read"] });
    const submit = await action();
    ui.getResource.mockResolvedValue(null);
    expect(await submit(other, { plate_number: "ABCD" })).toEqual({ ok: false });
    expect(ui.rpc).not.toHaveBeenCalled();
    ui.getResource.mockResolvedValue({ id: other });
    ui.rpc.mockResolvedValue({ ok: true, vehicle_id: "created", organization_id: other });
    expect(await submit(other, { plate_number: "ABCD" })).toEqual({ ok: true, vehicle_id: "created", organization_id: other });
    expect(ui.getResource).toHaveBeenCalledWith("organizations", other);
  });
});
