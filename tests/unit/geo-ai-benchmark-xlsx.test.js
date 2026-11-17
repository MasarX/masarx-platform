const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const {
  annotateCaseFeatures,
  buildCases,
  classifyAddressLineLanguage,
  deriveExpectedCountryIso2,
  evaluateCase,
  loadXlsxRows,
  prefetchCityTokenMap,
} = require('../../scripts/qa/benchmark-geo-ai-xlsx');

describe('geo-ai benchmark (xlsx) helpers', () => {
  test('classifyAddressLineLanguage detects ar/lat/mixed', () => {
    expect(classifyAddressLineLanguage('')).toBe('empty');
    expect(classifyAddressLineLanguage('الرياض حي العليا')).toBe('ar_only');
    expect(classifyAddressLineLanguage('Riyadh Al Olaya')).toBe('lat_only');
    expect(classifyAddressLineLanguage('Riyadh حي العليا')).toBe('mixed');
    expect(classifyAddressLineLanguage('12345')).toBe('other');
  });

  test('deriveExpectedCountryIso2 prefers ISO2 else fallback', () => {
    expect(deriveExpectedCountryIso2('SA', 'US')).toBe('SA');
    expect(deriveExpectedCountryIso2('us', 'SA')).toBe('US');
    expect(deriveExpectedCountryIso2('Saudi Arabia', 'SA')).toBe('SA');
    expect(deriveExpectedCountryIso2('', 'SA')).toBe('SA');
    expect(deriveExpectedCountryIso2(null, 'SA')).toBe('SA');
    expect(deriveExpectedCountryIso2('Saudi Arabia', '')).toBe(null);
  });

  test('buildCases supports scenario=matrix and creates stable ids', () => {
    const rows = [
      {
        Id: 1,
        Country: 'Saudi Arabia',
        City: 'Riyadh',
        'District name en': 'Al Olaya',
        'District name ar': 'العليا',
        'Test address lines': 'King Fahd Rd, Al Olaya, Riyadh',
      },
    ];

    const columns = {
      id: 'Id',
      country: 'Country',
      city: 'City',
      districtEn: 'District name en',
      districtAr: 'District name ar',
      addressLine: 'Test address lines',
    };

    const cases = buildCases(rows, columns, 'matrix');
    const ids = cases.map((c) => c.id);

    expect(cases).toHaveLength(4);
    expect(ids).toEqual(
      expect.arrayContaining([
        expect.stringContaining('::line_only'),
        expect.stringContaining('::line_plus_city'),
        expect.stringContaining('::district_only_en_plus_city'),
        expect.stringContaining('::district_only_ar_plus_city'),
      ]),
    );

    const lineOnly = cases.find((c) => c.scenario === 'line_only');
    expect(lineOnly.input.city_hint).toBe('');
    expect(lineOnly.input.address_line).toContain('King Fahd');

    const districtEn = cases.find((c) => c.scenario === 'district_only_en_plus_city');
    expect(districtEn.input.address_line).toBe('Al Olaya');

    const districtAr = cases.find((c) => c.scenario === 'district_only_ar_plus_city');
    expect(districtAr.input.address_line).toBe('العليا');
  });

  test('loadXlsxRows reads the selected sheet and preserves header columns', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-geo-ai-'));
    const filePath = path.join(tempDir, 'benchmark.xlsx');
    const workbook = new ExcelJS.Workbook();

    try {
      const first = workbook.addWorksheet('First');
      first.addRow([
        'Id',
        'Country',
        'City',
        'District name en',
        'District name ar',
        'Test address lines',
      ]);
      first.addRow([
        1,
        'Saudi Arabia',
        'Riyadh',
        'Al Olaya',
        'Ø§Ù„Ø¹Ù„ÙŠØ§',
        'King Fahd Rd, Al Olaya, Riyadh',
      ]);

      const second = workbook.addWorksheet('Second');
      second.addRow([
        'Id',
        'Country',
        'City',
        'District name en',
        'District name ar',
        'Test address lines',
      ]);
      second.addRow([
        2,
        'Saudi Arabia',
        'Jeddah',
        'Al Balad',
        'Ø§Ù„Ø¨Ù„Ø¯',
        'King Abdulaziz Rd, Al Balad, Jeddah',
      ]);

      await workbook.xlsx.writeFile(filePath);

      const loaded = await loadXlsxRows(filePath, 'Second');
      expect(loaded).toEqual([
        {
          Id: '2',
          Country: 'Saudi Arabia',
          City: 'Jeddah',
          'District name en': 'Al Balad',
          'District name ar': 'Ø§Ù„Ø¨Ù„Ø¯',
          'Test address lines': 'King Abdulaziz Rd, Al Balad, Jeddah',
        },
      ]);

      const fallback = await loadXlsxRows(filePath, '');
      expect(fallback[0].City).toBe('Riyadh');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('annotateCaseFeatures tags token presence', () => {
    const rows = [
      {
        Id: 1,
        Country: 'Saudi Arabia',
        City: 'Riyadh',
        'District name en': 'Al Olaya',
        'District name ar': 'العليا',
        'Test address lines': 'King Fahd Rd, Al Olaya, Riyadh',
      },
    ];

    const columns = {
      id: 'Id',
      country: 'Country',
      city: 'City',
      districtEn: 'District name en',
      districtAr: 'District name ar',
      addressLine: 'Test address lines',
    };

    const cases = buildCases(rows, columns, 'line_only');
    annotateCaseFeatures(cases, { Riyadh: ['Riyadh', 'الرياض'] });

    expect(cases[0].features.address_has_city_token).toBe(true);
    expect(cases[0].features.address_has_district_token).toBe(true);
  });

  test('evaluateCase scores city/district/country and flags hard errors', () => {
    const caseItem = {
      id: '1::line_only',
      scenario: 'line_only',
      input: { address_line: 'King Fahd Rd, Al Olaya, Riyadh', city_hint: '' },
      expected: {
        country_raw: 'Saudi Arabia',
        city_raw: 'Riyadh',
        district_en_raw: 'Al Olaya',
        district_ar_raw: 'العليا',
      },
    };

    const tokenMaps = { cityTokensByCityRaw: { Riyadh: ['Riyadh', 'الرياض'] } };
    const policy = { fallbackCountry: 'SA' };

    const ok = evaluateCase(
      caseItem,
      {
        normalized_line1: 'King Fahd Rd',
        city: 'الرياض',
        district: 'حي العليا',
        country: 'SA',
      },
      policy,
      tokenMaps,
    );

    expect(ok.ok).toBe(true);
    expect(ok.matches.city).toBe(true);
    expect(ok.matches.district).toBe(true);
    expect(ok.matches.country_iso2).toBe(true);

    const missingCity = evaluateCase(
      caseItem,
      {
        normalized_line1: 'King Fahd Rd',
        city: '',
        district: 'العليا',
        country: 'SA',
      },
      policy,
      tokenMaps,
    );

    expect(missingCity.ok).toBe(false);
    expect(missingCity.matches.city).toBe(false);
    expect(missingCity.hardErrors.join(' ')).toMatch(/city missing/i);

    const districtEqualsCity = evaluateCase(
      caseItem,
      {
        normalized_line1: 'King Fahd Rd',
        city: 'Riyadh',
        district: 'riyadh',
        country: 'SA',
      },
      policy,
      tokenMaps,
    );

    expect(districtEqualsCity.ok).toBe(false);
    expect(districtEqualsCity.hardErrors.join(' ')).toMatch(/district equals city/i);

    const invalidCountry = evaluateCase(
      caseItem,
      {
        normalized_line1: 'King Fahd Rd',
        city: 'Riyadh',
        district: 'Al Olaya',
        country: 'Saudi Arabia',
      },
      policy,
      tokenMaps,
    );

    expect(invalidCountry.ok).toBe(false);
    expect(invalidCountry.matches.country_iso2).toBe(false);
    expect(invalidCountry.hardErrors.join(' ')).toMatch(/country not iso2/i);
  });

  test('prefetchCityTokenMap merges canonical + alternate names', async () => {
    const client = {
      query: jest.fn(async () => ({
        rows: [
          {
            name_canonical: 'Riyadh',
            name_arabic: 'الرياض',
            alternate_names: ['Riyad'],
          },
        ],
      })),
    };

    const map = await prefetchCityTokenMap(client, '00000000-0000-0000-0000-000000000000', [
      'Riyadh',
    ]);

    expect(client.query).toHaveBeenCalled();
    expect(map.Riyadh).toEqual(expect.arrayContaining(['Riyadh', 'الرياض', 'Riyad']));
  });
});

