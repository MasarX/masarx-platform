import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { loadDemoContext } from "./utils/demo-accounts";
import { expectSignedIn, signInWithPassword } from "./utils/auth";
import { getPortalBasePath } from "./utils/base-paths";
import { isStrictE2EEnv } from "./utils/env";
import { appendMutationManifestEntry } from "./utils/mutation-manifest";
import { assertE2EMutationsAllowed } from "./utils/mutations";
import { fetchUserContext } from "./utils/role-matrix";
import { runWithRuntimeErrors } from "./utils/runtime-errors";
import {
  createAuthedSupabaseClient,
  rpcWithRetry,
  signOutSupabaseClient,
} from "./utils/supabase";

const demoContext = loadDemoContext();
const strict = isStrictE2EEnv();
const recurringTemplateName = "recurring_shipment_create_v1";

type DemoUser = (typeof demoContext.users)[number];

async function resolveRecurringShipmentTarget() {
  const users = demoContext.users.filter((user) => user.user_type === "client_admin");

  for (const user of users) {
    const context = await fetchUserContext({
      app: "portal",
      email: user.email,
      password: demoContext.password ?? "",
    });
    if (context.me?.access_scope?.scope_type !== "client") continue;
    if (!Array.isArray(context.me?.capabilities)) continue;
    if (!context.me.capabilities.includes("workflow_runs.write")) continue;
    return { user, scopeId: context.me.access_scope.scope_id ?? null };
  }

  return null;
}

async function resolveRecurringTemplateId(user: DemoUser) {
  const supabase = await createAuthedSupabaseClient({
    email: user.email,
    password: demoContext.password ?? "",
    label: `portal-recurring-template:${user.email}`,
  });

  try {
    const { data, error } = await rpcWithRetry<any>(
      supabase,
      "ui_list_resource_v1",
      {
        p_resource: "workflow_templates",
        p_filters: { name: recurringTemplateName },
        p_limit: 200,
        p_offset: 0,
        p_sort: null,
      },
      { label: `ui_list_resource_v1:workflow_templates:${user.email}` }
    );

    if (error || !data) {
      throw new Error(
        `Failed to list workflow_templates: ${(error as any)?.message || "no data"}`
      );
    }

    const items = Array.isArray(data.items) ? data.items : [];
    const matches = items.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        String((item as Record<string, unknown>).name ?? "").trim() === recurringTemplateName
    ) as Record<string, unknown>[];
    // A capped/estimated page cannot establish uniqueness across visible matches.
    if (data.total_is_estimate !== false || data.total_strategy !== "exact"
      || !Number.isSafeInteger(data.total) || data.total !== items.length) {
      throw new Error("Recurring template discovery did not return a complete exact result.");
    }
    if (matches.length > 1) throw new Error("Recurring template discovery returned ambiguous exact matches.");

    return matches.length === 1 && typeof matches[0].id === "string" ? matches[0].id : null;
  } finally {
    await signOutSupabaseClient(supabase, {
      label: `portal-recurring-template:${user.email}`,
    });
  }
}

test.describe("portal recurring shipment template", () => {
  test.skip(!demoContext.available && !strict, demoContext.reason ?? "Demo accounts missing.");

  test.beforeAll(() => {
    if (!demoContext.available && strict) {
      throw new Error(demoContext.reason ?? "Demo accounts missing.");
    }
  });

  test("creates and runs a recurring shipment schedule from the canonical workflow template", async ({
    page,
  }) => {
    if (!demoContext.available) {
      test.skip(true, demoContext.reason ?? "Demo accounts missing.");
    }

    assertE2EMutationsAllowed({
      label: "portal:recurring-shipment-schedule",
      details: "Creates and runs a recurring shipment schedule trigger from the portal.",
    });

    const basePath = getPortalBasePath();
    const target = await resolveRecurringShipmentTarget();
    if (!target) {
      if (strict) {
        throw new Error(
          "No portal client_admin demo user with workflow_runs.write was available for recurring shipment schedules."
        );
      }
      test.skip(
        true,
        "No portal client_admin demo user with workflow_runs.write was available for recurring shipment schedules."
      );
      return;
    }
    const resolvedTarget = target;

    const templateId = await resolveRecurringTemplateId(resolvedTarget.user);
    if (!templateId) {
      if (strict) {
        throw new Error(`Could not resolve ${recurringTemplateName} from workflow_templates.`);
      }
      test.skip(true, `Could not resolve ${recurringTemplateName} from workflow_templates.`);
      return;
    }
    const resolvedTemplateId = templateId;

    const note = `Recurring shipment E2E ${Date.now()}`;
    const uniqueRef = `E2E-RECURRING-${randomUUID()}`;
    let triggerId: string | null = null;
    let workflowRunId: string | null = null;
    let shipmentId: string | null = null;

    await runWithRuntimeErrors(page, { label: "portal-recurring-shipment-template" }, async () => {
      await page.goto(basePath || "/", { waitUntil: "domcontentloaded" });

      const authGate = page.locator('[data-testid="portal-auth-required"]');
      if (await authGate.isVisible()) {
        await signInWithPassword(page, resolvedTarget.user.email, demoContext.password || "");
      }
      await expectSignedIn(page, resolvedTarget.user.email, resolvedTarget.user.scope_type);

      await page.goto(
        `${basePath}/workflows/templates/${encodeURIComponent(resolvedTemplateId)}#workflow-triggers`,
        {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        }
      );

      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-ready"], [data-testid="portal-workflow-template-studio-error"]'
        )
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.locator('[data-testid="portal-workflow-template-studio-triggers-ready"]')
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-triggers-schedules-shipment-guide"]'
        )
      ).toBeVisible({ timeout: 20_000 });

      await page
        .locator('[data-testid="portal-workflow-template-studio-triggers-schedules-new"]')
        .click({ timeout: 20_000 });

      const modal = page.locator(
        '[data-testid="portal-workflow-template-studio-triggers-schedules-editor-modal"]'
      );
      await expect(modal).toBeVisible({ timeout: 20_000 });

      await modal.getByTestId("portal-workflow-template-studio-triggers-schedules-editor-notes").fill(note);
      await modal
        .locator(
          '[data-testid="portal-workflow-template-studio-triggers-schedules-editor-context-patch"]'
        )
        .fill(
          JSON.stringify({
            service_type: "delivery",
            shipment: { client_reference_number: uniqueRef },
          })
        );
      await modal.getByTestId("portal-workflow-template-studio-triggers-schedules-editor-submit").click({ timeout: 20_000 });
      await expect(modal).toBeHidden({ timeout: 30_000 });

      const scheduleRow = page
        .locator('[data-testid^="portal-workflow-template-studio-triggers-schedules-row-"]')
        .filter({ hasText: note })
        .first();
      await expect(scheduleRow).toBeVisible({ timeout: 60_000 });

      const rowTestId = await scheduleRow.getAttribute("data-testid");
      const rowMatch = rowTestId?.match(/row-(.+)$/);
      triggerId = rowMatch?.[1] ?? null;
      expect(triggerId).toBeTruthy();

      await scheduleRow.getByTestId(`portal-workflow-template-studio-triggers-schedules-run-${triggerId}`).click({ timeout: 20_000 });

      await expect.poll(() => page.url(), { timeout: 60_000 }).toContain("/workflows/runs/");
      const url = new URL(page.url());
      const urlMatch = url.pathname.match(/\/workflows\/runs\/([^/]+)$/);
      workflowRunId = urlMatch?.[1] ?? null;
      expect(workflowRunId).toBeTruthy();
    });

    if (!workflowRunId || !triggerId) {
      throw new Error("Expected workflow run id and schedule trigger id after Run now.");
    }

    const supabase = await createAuthedSupabaseClient({
      email: resolvedTarget.user.email,
      password: demoContext.password ?? "",
      label: `portal-recurring-shipment-run:${resolvedTarget.user.email}`,
    });

    try {
      const progress = await rpcWithRetry<any>(
        supabase,
        "progress_workflow_run_until_wait_v1",
        {
          p_workflow_run_id: workflowRunId,
          p_operation_result: {},
          p_budget_ms: 1_200,
          p_max_steps: 10,
        },
        { label: `progress_workflow_run_until_wait_v1:${workflowRunId}` }
      );
      if (progress.error) {
        throw new Error(
          `Failed to progress workflow run ${workflowRunId}: ${(progress.error as any)?.message || String(progress.error)}`
        );
      }

      const stepsResult = await rpcWithRetry<any>(
        supabase,
        "ui_list_resource_v1",
        {
          p_resource: "workflow_run_steps",
          p_filters: { workflow_run_id: workflowRunId },
          p_limit: 25,
          p_offset: 0,
          p_sort: null,
        },
        { label: `ui_list_resource_v1:workflow_run_steps:${workflowRunId}` }
      );

      if (stepsResult.error || !stepsResult.data) {
        throw new Error(
          `Failed to read workflow_run_steps: ${(stepsResult.error as any)?.message || "no data"}`
        );
      }

      const steps = Array.isArray(stepsResult.data.items) ? stepsResult.data.items : [];
      const createStep = steps.find((step) => {
        const record = step as Record<string, unknown>;
        return (
          String(record.handler_key ?? "").trim() === "shipment_create" ||
          String(record.operation_name ?? "").trim() === "create_shipment"
        );
      }) as Record<string, any> | undefined;

      expect(createStep).toBeTruthy();
      expect(createStep?.step_status).toBe("completed");
      const workflowRunResult = await rpcWithRetry<any>(
        supabase,
        "ui_get_resource_v1",
        { p_resource: "workflow_runs", p_id: workflowRunId },
        { label: `ui_get_resource_v1:workflow_runs:${workflowRunId}` }
      );
      if (workflowRunResult.error || !workflowRunResult.data) {
        throw new Error(
          `Failed to read workflow_runs ${workflowRunId}: ${(workflowRunResult.error as any)?.message || "no data"}`
        );
      }
      expect(workflowRunResult.data.workflow_status).toBe("completed");

      const shipmentsResult = await rpcWithRetry<any>(
        supabase,
        "ui_list_resource_v1",
        {
          p_resource: "shipments",
          p_filters: { client_reference_number: uniqueRef },
          p_limit: 25,
          p_offset: 0,
          p_sort: null,
        },
        { label: `ui_list_resource_v1:shipments:${uniqueRef}` }
      );
      if (shipmentsResult.error || !shipmentsResult.data) {
        throw new Error(
          `Failed to read shipments for ${uniqueRef}: ${(shipmentsResult.error as any)?.message || "no data"}`
        );
      }
      const visibleShipments = Array.isArray(shipmentsResult.data.items)
        ? shipmentsResult.data.items.filter(
            (shipment: Record<string, unknown>) =>
              String(shipment.client_reference_number ?? "").trim() === uniqueRef
          )
        : [];
      expect(visibleShipments).toHaveLength(1);
      shipmentId = String(visibleShipments[0]?.id ?? "").trim() || null;
      expect(shipmentId).toBeTruthy();

      if (shipmentId) {
        appendMutationManifestEntry({
          kind: "shipment",
          id: shipmentId,
          label: "portal:recurring-shipment-schedule",
          metadata: {
            workflow_run_id: workflowRunId,
            workflow_schedule_trigger_id: triggerId,
          },
        });
      }

      const deleteResult = await rpcWithRetry<any>(
        supabase,
        "ui_delete_resource_v1",
        { p_resource: "workflow_schedule_triggers", p_id: triggerId },
        { label: `ui_delete_resource_v1:${triggerId}` }
      );
      if (deleteResult.error) {
        throw new Error(
          `Failed to delete workflow_schedule_triggers ${triggerId}: ${(deleteResult.error as any)?.message || String(deleteResult.error)}`
        );
      }
    } finally {
      await signOutSupabaseClient(supabase, {
        label: `portal-recurring-shipment-run:${resolvedTarget.user.email}`,
      });
    }
  });
});
