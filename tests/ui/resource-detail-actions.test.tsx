import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { ResourceDetailActions } from "../../packages/ui/src/resource-detail-actions";

test("detail actions render bulk actions for a selected record", () => {
  renderWithIntl(
    <ResourceDetailActions
      detailId="ship_123"
      bulkActions={{
        resourceKey: "shipments",
        resource: {
          key: "shipments",
          relation: "shipments",
        },
        commands: [
          {
            key: "shipments.update",
            label: "Update shipment",
            execution: {
              type: "rpc",
              rpc: "ui_execute_command_v1",
              params: {
                handler: "resource_update",
                patch: { status: "ready" },
              },
            },
          },
        ],
        appBasePath: "/console",
        downloadBasePath: "/console/download",
        userCapabilities: ["shipments.write"],
      }}
    />
  );

  expect(
    screen.getByRole("button", { name: "Update shipment" })
  ).toBeInTheDocument();
});

test("detail actions render route run response commands for a selected assignment", () => {
  renderWithIntl(
    <ResourceDetailActions
      detailId="route_run_123"
      bulkActions={{
        resourceKey: "routes",
        resource: {
          key: "routes",
          relation: "public.route_runs_visible_v1",
        },
        commands: [
          {
            key: "route_runs.accept_assignment",
            label: "Accept assignment",
            capability: "routes.read",
            execution: {
              type: "rpc",
              rpc: "ui_execute_route_run_assignment_response_v1",
              params: {
                response_status: "accepted",
              },
              confirm: {
                title: "Accept assignment?",
              },
            },
          },
        ],
        appBasePath: "/console",
        downloadBasePath: "/console/download",
        userCapabilities: ["routes.read"],
      }}
    />
  );

  expect(
    screen.getByRole("button", { name: "Accept assignment" })
  ).toBeInTheDocument();
});

test("detail actions render route reassignment commands for a selected route", () => {
  renderWithIntl(
    <ResourceDetailActions
      detailId="route_run_456"
      bulkActions={{
        resourceKey: "routes",
        resource: {
          key: "routes",
          relation: "public.route_runs_visible_v1",
        },
        commands: [
          {
            key: "routes.reassign",
            label: "Reassign route",
            capability: "routes.write",
            execution: {
              type: "rpc",
              rpc: "ui_execute_route_run_assign_v1",
              params: {
                reassignment_reason: "Breakdown cover",
              },
            },
          },
        ],
        appBasePath: "/console",
        downloadBasePath: "/console/download",
        userCapabilities: ["routes.write"],
      }}
    />
  );

  expect(
    screen.getByRole("button", { name: "Reassign route" })
  ).toBeInTheDocument();
});

test("detail actions render route-stop reassignment commands for a selected stop", () => {
  renderWithIntl(
    <ResourceDetailActions
      detailId="route_stop_456"
      bulkActions={{
        resourceKey: "route_stops",
        resource: {
          key: "route_stops",
          relation: "public.route_stops_visible_v1",
        },
        commands: [
          {
            key: "route_stops.reassign",
            label: "Reassign selected stops",
            capability: "routes.write",
            execution: {
              type: "rpc",
              rpc: "ui_execute_route_stop_reassign_v1",
              params: {
                reassignment_reason: "Capacity rebalance",
              },
            },
          },
        ],
        appBasePath: "/console",
        downloadBasePath: "/console/download",
        userCapabilities: ["routes.write"],
      }}
    />
  );

  expect(
    screen.getByRole("button", { name: "Reassign selected stops" })
  ).toBeInTheDocument();
});

test("detail actions render guarded shipment requeue geocode commands for a selected shipment", () => {
  renderWithIntl(
    <ResourceDetailActions
      detailId="ship_456"
      bulkActions={{
        resourceKey: "shipments",
        resource: {
          key: "shipments",
          relation: "shipments",
        },
        commands: [
          {
            key: "shipments.update_geocode",
            label: "Requeue geocode",
            capability: "shipments.write",
            execution: {
              type: "rpc",
              rpc: "ui_execute_shipment_update_geocode_v1",
              params: {
                workflow_template_name: "shipment_update_geocode_v1",
              },
            },
            selection: { mode: "single", min_count: 1, max_count: 1 },
          },
        ],
        appBasePath: "/console",
        downloadBasePath: "/console/download",
        userCapabilities: ["shipments.write"],
      }}
    />
  );

  expect(
    screen.getByRole("button", { name: "Requeue geocode" })
  ).toBeInTheDocument();
});

test("detail actions render shipment cohort reschedule commands for a selected shipment", () => {
  renderWithIntl(
    <ResourceDetailActions
      detailId="ship_789"
      bulkActions={{
        resourceKey: "shipments",
        resource: {
          key: "shipments",
          relation: "shipments",
        },
        commands: [
          {
            key: "shipments.reschedule",
            label: "Reschedule shipments",
            capability: "shipments.write",
            execution: {
              type: "rpc",
              rpc: "ui_execute_shipment_batch_operation_v1",
              params: {
                operation: "reschedule",
              },
              input_schema: {
                version: 1,
                fields: [
                  {
                    key: "slot_date",
                    label: "Promised delivery date",
                    type: "text",
                    required: true,
                  },
                ],
              },
            },
            selection: { mode: "any", min_count: 1 },
          },
        ],
        appBasePath: "/console",
        downloadBasePath: "/console/download",
        userCapabilities: ["shipments.write"],
      }}
    />
  );

  expect(
    screen.getByRole("button", { name: "Reschedule shipments" })
  ).toBeInTheDocument();
});
