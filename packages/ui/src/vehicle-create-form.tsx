"use client";

import * as React from "react";
import { Button } from "./button";
import { JsonSchemaForm } from "./json-schema-form";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};

// Scope is supplied by the authenticated server page, never taken from form data.
export function scopeVehicleCreateSchema(schema: unknown, organizationId: string) {
  const root = record(schema);
  return { ...root, properties: Object.fromEntries(Object.entries(record(root.properties)).map(([key, field]) => {
    const property = record(field);
    const ui = record(property["x-ui"]);
    return [key, ui.widget === "resource_select"
      ? { ...property, "x-ui": { ...ui, filters: { ...record(ui.filters), organization_id: organizationId } } }
      : property];
  })) };
}

type Props = {
  actorId: string;
  organizationId: string;
  schema: unknown;
  canCreate: boolean;
  submitAction: (organizationId: string, value: unknown) => Promise<{ ok: boolean; vehicle_id?: string; organization_id?: string }>;
  labels: { submit: string; submitting: string; succeeded: string; failed: string; denied: string };
};

export function VehicleCreateTargetForm(props: Omit<Props, "organizationId"> & {
  organizationId: string | null;
  canSelectOrganization: boolean;
}) {
  return <ScopedVehicleCreateTargetForm key={JSON.stringify([props.actorId, props.organizationId, props.canSelectOrganization])} {...props} />;
}

function ScopedVehicleCreateTargetForm(props: Omit<Props, "organizationId"> & {
  organizationId: string | null;
  canSelectOrganization: boolean;
}) {
  const [target, setTarget] = React.useState<unknown>({});
  const selected = props.canSelectOrganization ? record(target).organization_id : props.organizationId;
  const organizationId = typeof selected === "string" ? selected : "";
  return <div className="space-y-4">
    {props.canSelectOrganization ? <JsonSchemaForm
      schema={{ type: "object", properties: { organization_id: { type: "string", title: "Organization",
        "x-ui": { widget: "resource_select", resource: "organizations", label_column: "name" } } } }}
      value={target} onChange={setTarget} testIdPrefix="vehicle-create-target" /> : null}
    {organizationId ? <VehicleCreateForm {...props} organizationId={organizationId} />
      : <p role="status">Select an organization to load its vehicle types and branches.</p>}
  </div>;
}

// Remounting invalidates all selector requests and selections when actor/tenant changes.
export function VehicleCreateForm(props: Props) {
  return <ScopedVehicleCreateForm key={JSON.stringify([props.actorId, props.organizationId])} {...props} />;
}

function ScopedVehicleCreateForm({ actorId, organizationId, schema, canCreate, labels, submitAction }: Props) {
  const [value, setValue] = React.useState<unknown>({});
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<"success" | "error" | null>(null);
  const mounted = React.useRef(true);
  const inFlight = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const scopedSchema = React.useMemo(() => scopeVehicleCreateSchema(schema, organizationId), [schema, organizationId]);
  const enabled = Boolean(actorId && organizationId && canCreate);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setResult(null);
    try {
      // The canonical RPC validates tenant/type/branch ownership again; never retry creation.
      const created = await submitAction(organizationId, value);
      if (created.ok !== true || !created.vehicle_id || created.organization_id !== organizationId) throw new Error("vehicle_create_unconfirmed");
      if (mounted.current) { setResult("success"); setValue({}); }
    } catch {
      if (mounted.current) setResult("error");
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }

  if (!enabled) return <p role="alert">{labels.denied}</p>;
  return <form onSubmit={submit} className="space-y-4" data-testid="vehicle-create-form">
    <JsonSchemaForm schema={scopedSchema} value={value} onChange={setValue}
      disabled={pending} testIdPrefix="vehicle-create" />
    {result ? <p role={result === "error" ? "alert" : "status"}>{result === "success" ? labels.succeeded : labels.failed}</p> : null}
    <Button type="submit" disabled={pending}>{pending ? labels.submitting : labels.submit}</Button>
  </form>;
}
