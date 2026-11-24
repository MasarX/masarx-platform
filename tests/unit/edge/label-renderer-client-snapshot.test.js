const { File } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PDFDocument } = require('pdf-lib');
const ts = require('typescript');

test('label renderer returns the client template identity from the composed job snapshot', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../supabase/functions/label-renderer/index.ts'), 'utf8');
  const section = (start, end) => {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    if (first < 0 || last <= first) throw new Error(`Renderer section not found: ${start}`);
    return source.slice(first, last);
  };
  const compiled = ts.transpileModule([
    section('class TemplateError extends Error', 'const SUPABASE_URL'),
    section('const resolveTemplateSnapshot =', 'const resolveSettingsScope ='),
    section('const normalizeString =', 'const readBooleanSetting ='),
    section('const renderTemplatePdf =', 'const buildFallbackPdf ='),
    section('const renderAndUploadLabelFromComposedPayload =', 'const handleDesignerPreview ='),
    'module.exports = renderAndUploadLabelFromComposedPayload;',
  ].join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const renderer = { exports: {} };
  const storageUploadObject = jest.fn(async () => ({ error: null }));
  vm.runInNewContext(compiled, {
    module: renderer, File, storageUploadObject, LABEL_BUCKET: 'labels',
    PDFDocument: { async create() {
      const document = await PDFDocument.create({ updateMetadata: false });
      return { addPage: (size) => document.addPage(Array.from(size)), save: () => document.save() };
    } },
    performance: { now: () => 0 },
    ensureRendererDeps: async () => {},
    loadTemplateAssets: async () => new Map(),
    renderTemplateBlocksToPage: async () => ({ renderedBlocks: 1, barcodeBlocks: 0 }),
    buildLabelOutputFilePath: (orgId, jobId) => `${orgId}/${jobId}.pdf`,
  }, { filename: 'label-renderer-client-snapshot.ts' });

  const template = {
    template_id: 'client-design',
    template_key: 'client_shipping',
    resolved_scope: 'client',
    renderer_config: { blocks: [{ type: 'text' }] },
  };
  const result = await renderer.exports(
    { id: 'job', organization_id: 'org', client_id: 'client', template_id: 'tenant-default', attempts: 0 },
    'fixture-request', {}, { job: { template } }, 0,
  );

  expect(storageUploadObject).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    status: 'ok',
    metadata: { template_id: template.template_id, template_key: template.template_key },
  });
});
