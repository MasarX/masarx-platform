import "server-only";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createUiServerClient } from "@masarx/api/server";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { hasCapability, resolveCapabilitySet, resolveResourceReadScopeId } from "./capabilities";
import { fetchCommandRegistry } from "./command-registry";
import { VehicleCreateTargetForm } from "./vehicle-create-form";

type VehicleCreatePageProps = { testIdPrefix: string };

export async function VehicleCreatePage({ testIdPrefix }: VehicleCreatePageProps) {
  const ui = createUiServerClient();
  let me;
  try { me = await ui.me(); } catch { return <p role="alert" data-testid={`${testIdPrefix}-error`}>Vehicle creation is unavailable. Try again.</p>; }
  const organizationId = resolveResourceReadScopeId(me.access_scope?.scope_type, me.access_scope?.scope_id, me.org?.id);
  const capabilities = resolveCapabilitySet(me.capabilities);
  const canSelectOrganization = me.access_scope?.scope_type === "platform" && hasCapability(capabilities, "organizations.read");
  const hasTenant = me.access_scope?.scope_type === "tenant" && Boolean(organizationId);
  if (!me.user?.id || (!hasTenant && !canSelectOrganization)
      || !hasCapability(capabilities, "fleet.write") || !hasCapability(capabilities, "fleet.read")) {
    return <p role="alert" data-testid={`${testIdPrefix}-blocked`}>Select an authorized tenant scope with fleet write access to create a vehicle.</p>;
  }
  const registry = await fetchCommandRegistry(ui);
  const command = registry.commands.find(item => item.key === "vehicles.create");
  if (registry.error || !command?.schema_category || command.capability !== "fleet.write") {
    return <p role="alert" data-testid={`${testIdPrefix}-error`}>Vehicle creation is not configured for this scope.</p>;
  }
  let schema;
  try {
    const result = await ui.listResource("vehicle_create_form_schema", { category: command.schema_category, is_active: true }, 1, 0, { key: "version", direction: "desc" });
    schema = result.items[0]?.schema;
  } catch { return <p role="alert" data-testid={`${testIdPrefix}-error`}>Vehicle form configuration could not be loaded. Try again.</p>; }
  if (!schema) return <p role="alert" data-testid={`${testIdPrefix}-error`}>Vehicle form configuration is unavailable.</p>;
  const actorId = me.user.id;
  async function submitAction(targetId: string, value: unknown) {
    "use server";
    try {
      const current = createUiServerClient();
      const identity = await current.me();
      const caps = resolveCapabilitySet(identity.capabilities);
      if (identity.user?.id !== actorId || !hasCapability(caps, "fleet.write") || !hasCapability(caps, "fleet.read")) return { ok: false };
      const tenant = identity.access_scope?.scope_type === "tenant";
      const platform = identity.access_scope?.scope_type === "platform" && hasCapability(caps, "organizations.read");
      if ((!tenant && !platform) || (tenant && targetId !== identity.org?.id)) return { ok: false };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) return { ok: false };
      if (platform && (await current.getResource("organizations", targetId))?.id !== targetId) return { ok: false };
      const latest = await fetchCommandRegistry(current);
      const definition = latest.commands.find(item => item.key === "vehicles.create");
      if (latest.error || definition?.capability !== "fleet.write" || !definition.schema_category) return { ok: false };
      const result = await current.listResource("vehicle_create_form_schema", { category: definition.schema_category, is_active: true }, 1, 0, { key: "version", direction: "desc" });
      const currentSchema = result.items[0]?.schema;
      if (!currentSchema || !value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
      const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
      addFormats(ajv);
      if (!ajv.compile(currentSchema)(value)) return { ok: false };
      const created = await current.rpc<{ ok: boolean; vehicle_id: string; organization_id: string }>(
        "create_vehicle_v1", { p_args: { ...value, organization_id: targetId } }, { retries: 0 }
      );
      if (created.ok !== true || created.organization_id !== targetId || !created.vehicle_id) return { ok: false };
      return { ok: true, vehicle_id: created.vehicle_id, organization_id: created.organization_id };
    } catch { return { ok: false }; }
  }
  return <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
    <PageHeader title={command.label} description={command.description ?? undefined} />
    <Section title={command.label} collapsible={false}>
      <VehicleCreateTargetForm actorId={me.user.id} organizationId={hasTenant ? organizationId : null}
        canSelectOrganization={canSelectOrganization} schema={schema} canCreate submitAction={submitAction}
        labels={{ submit: "Create vehicle", submitting: "Creating vehicle…", succeeded: "Vehicle created.",
          failed: "Vehicle could not be created. Check the fields and try again.", denied: "Vehicle creation is unavailable." }} />
    </Section>
  </div>;
}
