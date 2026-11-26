const { checkPreview, EXIT } = require('../../../scripts/deploy/dev-label-render-probe.cjs');

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
