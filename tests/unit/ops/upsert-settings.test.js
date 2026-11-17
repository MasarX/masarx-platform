const { deepMerge } = require('../../../scripts/ops/upsert-settings');

describe('upsert-settings', () => {
  test('deepMerge merges objects and replaces arrays', () => {
    const base = {
      a: 1,
      b: { c: 1, d: 2 },
      e: [1, 2],
      f: null
    };
    const patch = {
      b: { d: 3, e: 4 },
      e: [3],
      f: { x: 1 },
      g: null
    };
    expect(deepMerge(base, patch)).toEqual({
      a: 1,
      b: { c: 1, d: 3, e: 4 },
      e: [3],
      f: { x: 1 },
      g: null
    });
  });
});
