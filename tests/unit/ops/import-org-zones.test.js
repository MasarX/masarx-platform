const { normalizeSlug, parseDistrictRef } = require('../../../scripts/ops/import-org-zones');

describe('import-org-zones', () => {
  test('normalizeSlug lowercases', () => {
    expect(normalizeSlug('Z-North')).toBe('z-north');
  });

  test('parseDistrictRef accepts string name', () => {
    expect(parseDistrictRef('Al Olaya')).toEqual({
      canonicalDistrictId: '',
      canonicalDistrictName: 'Al Olaya'
    });
  });

  test('parseDistrictRef accepts id', () => {
    expect(parseDistrictRef({ canonical_district_id: '11111111-1111-1111-1111-111111111111' })).toEqual({
      canonicalDistrictId: '11111111-1111-1111-1111-111111111111',
      canonicalDistrictName: ''
    });
  });

  test('parseDistrictRef accepts canonical name', () => {
    expect(parseDistrictRef({ canonical_district_name: 'Al Malaz' })).toEqual({
      canonicalDistrictId: '',
      canonicalDistrictName: 'Al Malaz'
    });
  });

  test('parseDistrictRef rejects empty', () => {
    expect(() => parseDistrictRef({})).toThrow(/requires canonical_district_id or canonical_district_name/);
  });
});

