const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');
const { checkPreview, renderPreview, EXIT } = require('../../../scripts/deploy/dev-label-render-probe.cjs');

test('DEV label renderer verification runs after Edge deploy independently of the app deploys', () => {
  const { jobs } = parse(readFileSync(resolve(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8'));
  const probe = jobs['label-render-probe'];
  const command = 'node scripts/deploy/dev-label-render-probe.cjs';
  expect(probe.needs).toBe('database');
  expect(probe.environment.name).toBe('dev');
  expect(probe.if).toContain("github.ref == 'refs/heads/main'");
  expect(probe.if).toContain("needs.database.result == 'success'");
  expect(probe.if).toContain("needs.database.outputs.edge_deployed == 'true'");
  expect(probe['continue-on-error']).toBeUndefined();
  expect(probe.steps).toContainEqual(expect.objectContaining({ run: command }));
  expect(jobs.database.outputs.edge_deployed).toBe("${{ steps.deploy.outcome == 'success' }}");
  expect(jobs.database.steps).not.toContainEqual(expect.objectContaining({ run: command }));
  for (const name of ['console', 'portal', 'landing', 'ingress']) expect(jobs[name].needs).toBe('database');
  expect(jobs.summary.needs).toContain('label-render-probe');
});

test('DEV label probe reports a sanitized configuration failure in the job summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'label-probe-'));
  const summary = join(dir, 'summary');
  try {
    const script = resolve(__dirname, '../../../scripts/deploy/dev-label-render-probe.cjs');
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: summary },
    });
    const line = `LABEL_PROBE_ERROR code=${EXIT.configuration}\n`;
    expect(result.status).toBe(EXIT.configuration);
    expect(result.stderr).toBe(line);
    expect(readFileSync(summary, 'utf8')).toBe(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the DEV label probe requires HTTP 200, ok true and canonical base64 PDF bytes', () => {
  const pdf = Buffer.from('%PDF-1.7\n\n');
  const body = { ok: true, pdf_base64: pdf.toString('base64') };
  expect(checkPreview(200, body)).toEqual({ code: 0, pdfBytes: pdf.length });
  expect(checkPreview(201, body)).toEqual({ code: 17 });
  expect(checkPreview(503, body)).toEqual({ code: 17 });
  expect(checkPreview(200, null)).toEqual({ code: 18 });
  expect(checkPreview(200, { ...body, ok: 'true' })).toEqual({ code: 18 });
  for (const encoded of [null, '', body.pdf_base64 + '!', body.pdf_base64.replace(/=+$/, ''),
    Buffer.from('PDF-1.7').toString('base64'),
    Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]).toString('base64')]) {
    expect(checkPreview(200, { ...body, pdf_base64: encoded })).toEqual({ code: 19 });
  }
  expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
});

test.each([
  [[null, 503, 200], 0, [1000, 2000]],
  [[503, 502, 500], EXIT.renderStatus, [1000, 2000]],
  [[null, null, null], EXIT.renderNetwork, [1000, 2000]],
  [[403], EXIT.renderStatus, []],
])('DEV label probe handles renderer results %j with code %i and waits %j', async (statuses, code, waits) => {
  const pdf = Buffer.from('%PDF-1.7\n\n');
  const send = jest.fn();
  for (const status of statuses) {
    if (status === null) send.mockRejectedValueOnce(new Error('fixture network failure'));
    else send.mockResolvedValueOnce({
      status,
      text: async () => JSON.stringify({ ok: true, pdf_base64: pdf.toString('base64') }),
    });
  }
  const wait = jest.fn().mockResolvedValue(undefined);
  await expect(renderPreview(send, wait)).resolves.toEqual(code === 0 ? { code, pdfBytes: pdf.length } : { code });
  expect(send).toHaveBeenCalledTimes(statuses.length);
  expect(wait.mock.calls).toEqual(waits.map(ms => [ms]));
});
