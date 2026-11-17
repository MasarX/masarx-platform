const { extractTaggedWaybillGeometry } = require('../../scripts/templates/figma/waybill-geometry');

test('extracts geometry from a generated synthetic label frame', () => {
  const box = (x, y, width, height) => ({ x, y, width, height });
  const field = { id: 'example-field', type: 'TEXT', name: 'field:payment_term', absoluteBoundingBox: box(10, 20, 30, 10) };
  const section = { type: 'GROUP', name: 'section:header', absoluteBoundingBox: box(0, 0, 100, 50), children: [field] };
  const root = { id: 'example-frame', type: 'FRAME', name: 'Synthetic', absoluteBoundingBox: box(0, 0, 288, 432), children: [{ type: 'GROUP', name: 'EXPORT', children: [section] }] };
  const geometry = extractTaggedWaybillGeometry(root, { dpi: 72, pageWidthInch: 4, pageHeightInch: 6 });
  expect(geometry.root_frame.id).toBe('example-frame');
  const value = geometry.fields.find(item => item.field_key === 'payment_term');
  expect(value.section_key).toBe('header');
  expect(value.x_pt).toBe(10);
  expect(value.y_pt).toBe(402);
  expect(value.width_pt).toBe(30);
  expect(value.height_pt).toBe(10);
});
