const fs = require('node:fs');
const path = require('node:path');

const readRepoFile = (relativePath) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('B4 product contracts', () => {
  test.each([
    'supabase/migrations/202608161630_b4_request_entry_point_workflow_sources_v1.sql',
    'supabase/migrations/202608161640_b4_workflow_trigger_decision_lookup_v1.sql',
  ])('%s converges retired and expired lookup rows', (relativePath) => {
    const sql = readRepoFile(relativePath);
    expect(sql).toMatch(/ON CONFLICT \(lookup_definition_id, value\) DO UPDATE/);
    expect(sql).toMatch(/status = 'active'/);
    expect(sql).toMatch(/retired_at = NULL/);
    expect(sql).toMatch(/effective_from = NULL/);
    expect(sql).toMatch(/effective_until = NULL/);
    expect(sql).toMatch(/lookup contract is incomplete/);
  });

  test('workflow studio persistence proof fails closed when the enabled control is absent', () => {
    const source = readRepoFile('tests/e2e/utils/workflow-studio.ts');
    const helper = source.slice(
      source.indexOf('export async function toggleWorkflowTemplateFlowStepEnabledAndVerifyPersistence'),
      source.indexOf('export async function wheelZoomWorkflowTemplateFlowCanvas'),
    );
    expect(helper).toContain('await expect(enabledCheckbox).toBeVisible({ timeout: 20_000 });');
    expect(helper).not.toContain('return false');
    expect(helper).toContain('name: workflowStepEnabledLabel()');
    expect(source).toContain('`${fields.enabled} ${fields.enabledHint}`');
    expect(helper).toContain('await enabledCheckbox.setChecked(expectedEnabled);');
    expect(helper).toContain('await page.reload({ waitUntil: "domcontentloaded" });');
    expect(helper).toContain('checked: expectedEnabled');
  });

  test.each(['en', 'ar'])('enabled checkbox catalog name uniquely matches the labelled control in %s', (locale) => {
    const fields = JSON.parse(readRepoFile(`packages/config/messages/${locale}.json`)).ui.workflowStudio.steps.builder.add.fields;
    expect(fields.enabled).toBeTruthy();
    expect(fields.manual).toBeTruthy();
    expect(fields.manualHint).toBeTruthy();
    expect(`${fields.enabled} ${fields.enabledHint}`).toContain(fields.enabled);
    expect(`${fields.manual} ${fields.manualHint}`).not.toContain(fields.enabled);
  });

  test('app metadata binds all icon roles to the safe application base path', () => {
    const source = readRepoFile('apps/shared/app-layout.tsx');
    expect(source).toContain('const iconHref = safeBasePath ? `${safeBasePath}/icon.svg` : "/icon.svg";');
    expect(source).toContain('icon: [{ url: iconHref, type: "image/svg+xml" }]');
    expect(source).toContain('shortcut: [{ url: iconHref, type: "image/svg+xml" }]');
    expect(source).toContain('apple: [{ url: iconHref, type: "image/svg+xml" }]');
  });

  test('integration plugin studio maps invalid tokens and denied capabilities distinctly', () => {
    const source = readRepoFile('supabase/functions/integration-plugin-studio/index.ts');
    expect(source).toContain('throw createHttpError(400, message, "edge.auth.invalid_token")');
    expect(source).toContain('"edge.integration_plugin_studio.capability_denied"');
    expect(source).toMatch(/if \(code === "42501" \|\| \/\^Capability denied:/);
    expect(source).toContain('const status = getHttpErrorStatus(error);');
    expect(source).toContain('return studioResponse(status, buildErrorEnvelope({ status, code, message,');
    expect(source).toContain('details: getHttpErrorDetails(error, { endpoint })');
    expect(source).toContain('const projected = await projectStudioPayload(userClient, payload)');
  });
});
