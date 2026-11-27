const { appendFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { FixtureError: ProbeError, requireFixture: requireProbe, request, withDevFixture } = require('./dev-synthetic-fixture.cjs');

const EXIT = Object.freeze({
  configuration: 10,
  credentials: 11,
  database: 12,
  authCreate: 13,
  fixture: 14,
  signIn: 15,
  renderNetwork: 16,
  renderStatus: 17,
  renderResponse: 18,
  renderPdf: 19,
  cleanupDatabase: 20,
  cleanupAuth: 21,
  cleanupVerify: 22,
  unexpected: 23,
});
const pdfHeader = Buffer.from('%PDF-');
const labelType = 'shipping';
// Only fixed codes from the renderer's non-200 designer preview responses are safe to report.
const previewErrorCodes = new Set([
  'auth_required', 'draft_id_required', 'shipment_id_required', 'config_missing',
  'org_required', 'draft_not_found', 'template_missing', 'payload_missing',
]);

function checkPreview(status, body) {
  if (status !== 200) return { code: EXIT.renderStatus };
  if (body?.ok !== true) return { code: EXIT.renderResponse };
  const encoded = body.pdf_base64;
  if (typeof encoded !== 'string') return { code: EXIT.renderPdf };
  const pdf = Buffer.from(encoded, 'base64');
  if (pdf.toString('base64') !== encoded || !pdf.subarray(0, pdfHeader.length).equals(pdfHeader)) {
    return { code: EXIT.renderPdf };
  }
  return { code: 0, pdfBytes: pdf.length };
}

async function renderPreview(send, wait = delay) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    let status;
    let text;
    try {
      response = await send();
      status = response.status;
      if (status === 200) text = await response.text();
    } catch {
      status = undefined;
    }
    if (status === 200 && text !== undefined) {
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw new ProbeError(EXIT.renderResponse);
      }
      return checkPreview(status, result);
    }
    if (status !== undefined) {
      if (status < 500 || status >= 600 || attempt === 2) {
        const body = await response.json().catch(() => null);
        const errorCode = body?.error?.code;
        const rendererCode = previewErrorCodes.has(errorCode) ? errorCode : 'unavailable';
        return {
          code: EXIT.renderStatus,
          diagnostic: `LABEL_PROBE_RENDER_ERROR status=${status} renderer_code=${rendererCode}`,
        };
      }
      await response.body?.cancel().catch(() => {});
    }
    if (attempt < 2) await wait(1000 * 2 ** attempt);
    else return { code: EXIT.renderNetwork };
  }
}

async function seedUser(db, { organizationId, email, tag }, userId) {
  await db.query(`INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
    VALUES ($1, $2, $3, $4, 'ops_admin', 'active', 'tenant')`, [userId, organizationId, email, tag]);
  const { rowCount } = await db.query(`INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id)
    SELECT $1, $2, role_id FROM public.provision_rbac_roles_from_templates_v1($1, ARRAY['ops_admin'], $2)`,
  [organizationId, userId]);
  requireProbe(rowCount === 1, EXIT.fixture);
}

async function seedLabel(db, { organizationId, shipmentId, boxId, draftId, tag, clientId, tracking }, userId) {
  const draft = {
    version: 'draft',
    templates: {
      [labelType]: {
        version: '1.0.0',
        template_key: labelType,
        label_type: labelType,
        page: { width_inch: 4, height_inch: 6, dpi: 203, orientation: 'portrait' },
        blocks: [{
          id: 'title', type: 'text', x: 24, y: 24, width: 240, height: 24, font_size: 12,
          text_expr: { op: 'literal', value: tag },
        }],
      },
    },
  };
  await db.query(`INSERT INTO public.shipment_boxes (id, shipment_id, organization_id, client_id, box_number, barcode)
    VALUES ($1, $2, $3, $4, 1, $5)`, [boxId, shipmentId, organizationId, clientId, `${tracking}:1`]);
  await db.query(`INSERT INTO public.label_design_drafts
    (id, organization_id, scope_type, scope_id, label_type, draft_name, draft_value, created_by)
    VALUES ($1, $2, 'tenant', $2, $3, $4, $5, $6)`,
  [draftId, organizationId, labelType, tag, draft, userId]);
}

async function run(env) {
  let renderDiagnostic;
  const { result, error, cleanupErrors, cleaned } = await withDevFixture(env, {
    prefix: 'dev-label-probe',
    marker: 'dev_label_probe',
    exit: EXIT,
    seedUser,
    seedExtra: seedLabel,
    extraRows: ({ organizationId, clientId, shipmentId, boxId, draftId }) => ({
      label_design_drafts: ['id = $1 AND organization_id = $2', [draftId, organizationId]],
      shipment_boxes: ['id = $1 AND shipment_id = $2 AND client_id = $3', [boxId, shipmentId, clientId]],
    }),
  }, async ({ projectUrl, anonKey, shipmentId, boxId, draftId, signIn }) => {
    const { access_token: jwt } = await signIn();
    const rendered = await renderPreview(() => request(
      `${projectUrl}/functions/v1/label-renderer`, { apikey: anonKey, authorization: `Bearer ${jwt}` }, 'POST', {
        mode: 'designer_preview', user_jwt: jwt, label_type: labelType,
        draft_id: draftId, shipment_id: shipmentId, shipment_box_id: boxId,
      },
    ));
    // Kept outside the callback so a non-200 render still reports its status after cleanup.
    renderDiagnostic = rendered.diagnostic;
    requireProbe(rendered.code === 0, rendered.code);
    return rendered.pdfBytes;
  });
  const errors = error ? [error instanceof ProbeError ? error.code : EXIT.renderNetwork] : [];
  return { pdfBytes: result, renderDiagnostic, cleaned, errors: [...errors, ...cleanupErrors] };
}

async function main() {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const evidence = [];
  let errors = [];
  let renderDiagnostic;
  try {
    const result = await run(process.env);
    ({ errors, renderDiagnostic } = result);
    if (result.pdfBytes) evidence.push(`LABEL_PROBE status=200 pdf_bytes=${result.pdfBytes} sha=${process.env.GITHUB_SHA}`);
    if (result.cleaned) evidence.push('LABEL_PROBE_CLEANUP rows=0');
  } catch (error) {
    errors.push(error instanceof ProbeError ? error.code : EXIT.unexpected);
  }
  const failures = errors.map(code => `LABEL_PROBE_ERROR code=${code}`);
  if (renderDiagnostic) failures.push(renderDiagnostic);
  for (const line of evidence) console.log(line);
  for (const line of failures) console.error(line);
  if (summary) {
    try {
      appendFileSync(summary, `${[...evidence, ...failures].join('\n')}\n`);
    } catch {
      console.error(`LABEL_PROBE_ERROR code=${EXIT.unexpected}`);
      errors.push(EXIT.unexpected);
    }
  }
  process.exitCode = errors.at(-1) ?? 0;
}

if (require.main === module) void main();

module.exports = { checkPreview, renderPreview, EXIT };
