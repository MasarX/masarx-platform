export type WorkflowScheduleTemplateGuideKind =
  | "shipment_create"
  | "shipment_create_reserved";

export type WorkflowScheduleTemplateGuide = {
  kind: WorkflowScheduleTemplateGuideKind;
  exampleContextPatch: Record<string, unknown>;
};

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function hasHandler(
  steps: Record<string, unknown>[],
  predicate: (step: Record<string, unknown>) => boolean
) {
  return steps.some((step) => predicate(step));
}

export function resolveWorkflowScheduleTemplateGuide(
  steps: Record<string, unknown>[] | null | undefined
): WorkflowScheduleTemplateGuide | null {
  const resolvedSteps = Array.isArray(steps) ? steps : [];
  if (resolvedSteps.length === 0) return null;

  const hasShipmentCreate = hasHandler(resolvedSteps, (step) => {
    const handlerKey = normalizeText(step.handler_key);
    const operationName = normalizeText(step.operation_name);
    return handlerKey === "shipment_create" || operationName === "create_shipment";
  });

  if (!hasShipmentCreate) return null;

  const hasReserveStep = hasHandler(resolvedSteps, (step) => {
    const handlerKey = normalizeText(step.handler_key);
    const operationName = normalizeText(step.operation_name);
    return (
      handlerKey === "reserve_shipment_identifiers" ||
      handlerKey === "reserve_identifiers" ||
      operationName === "reserve_identifiers"
    );
  });

  if (hasReserveStep) {
    return {
      kind: "shipment_create_reserved",
      exampleContextPatch: {
        client_id: "<client-uuid-for-tenant-scoped-schedules>",
        service_type: "delivery",
        shipment: {
          client_reference_number: "optional-reference",
        },
      },
    };
  }

  return {
    kind: "shipment_create",
    exampleContextPatch: {
      client_id: "<client-uuid>",
      planned_tracking_number: "MX-TRACK-001",
      service_type: "delivery",
    },
  };
}
