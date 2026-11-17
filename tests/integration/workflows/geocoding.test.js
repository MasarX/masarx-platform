const here = require('../../../scripts/clients/here');

const liveEnabled = process.env.RUN_LIVE_GEOCODING_TESTS === 'true';

(liveEnabled ? describe : describe.skip)('Geocoding workflow', () => {
  beforeAll(async () => {
    await here.getConfig();
  });

  afterAll(async () => {
    if (typeof here.shutdown === 'function') {
      await here.shutdown();
    }
  });

  test('geocode and reverse geocode round-trip', async () => {
    const geocodeResult = await here.geocode('Riyadh, Saudi Arabia', {
      limit: 1,
      lang: 'en'
    });
    expect(Array.isArray(geocodeResult.items)).toBe(true);
    expect(geocodeResult.items.length).toBeGreaterThan(0);

    const { position } = geocodeResult.items[0];
    expect(position).toHaveProperty('lat');
    expect(position).toHaveProperty('lng');

    const reverseResult = await here.reverseGeocode(
      { lat: position.lat, lng: position.lng },
      { limit: 1 }
    );
    expect(Array.isArray(reverseResult.items)).toBe(true);
    expect(reverseResult.items.length).toBeGreaterThan(0);
  });

  test('geocode supports HERE country filter (in=countryCode:SAU) and types=address', async () => {
    const geocodeResult = await here.geocode('King Fahd Rd 10, Riyadh, Saudi Arabia', {
      limit: 1,
      lang: 'en',
      in: 'countryCode:SAU',
      types: 'address',
    });

    expect(Array.isArray(geocodeResult.items)).toBe(true);
    expect(geocodeResult.items.length).toBeGreaterThan(0);
    const address = geocodeResult.items[0]?.address || {};
    expect((address.street || address.city || address.county || address.state || address.label || '').length).toBeGreaterThan(0);
  });

  test('reverse geocode returns city and district for Riyadh centroid', async () => {
    const reverseResult = await here.reverseGeocode(
      { lat: 24.7136, lng: 46.6753 },
      { limit: 1, lang: 'en' }
    );

    expect(Array.isArray(reverseResult.items)).toBe(true);
    expect(reverseResult.items.length).toBeGreaterThan(0);

    const item = reverseResult.items[0];
    const address = item.address || {};
    const cityCandidate =
      (address.city ||
        address.county ||
        address.state ||
        address.label ||
        '').toLowerCase();
    const districtCandidate =
      (address.district || address.subdistrict || address.label || '').toLowerCase();

    expect(cityCandidate.length).toBeGreaterThan(0);
    expect(districtCandidate.length).toBeGreaterThan(0);
  });

  test('reverse geocode normalizes mixed-language address input', async () => {
    const geocodeResult = await here.geocode('برج المملكة، الرياض Saudi Arabia', {
      limit: 1,
      lang: 'ar'
    });
    expect(geocodeResult.items.length).toBeGreaterThan(0);

    const { position } = geocodeResult.items[0];
    const reverseResult = await here.reverseGeocode(
      { lat: position.lat, lng: position.lng },
      { limit: 1, lang: 'ar' }
    );

    expect(reverseResult.items.length).toBeGreaterThan(0);
    const address = reverseResult.items[0].address || {};
    const label = address.label || '';
    expect(label.length).toBeGreaterThan(0);
    expect((address.city || address.county || label).length).toBeGreaterThan(0);
    expect((address.district || address.subdistrict || label).length).toBeGreaterThan(0);
  });

  const liveShortCode = String(process.env.LIVE_SA_SHORT_CODE || '').trim();
  const shortCodeTest = liveShortCode ? test : test.skip;

  shortCodeTest('geocode resolves Saudi short code (format ABCD1234) with in/types hints', async () => {
    const geocodeResult = await here.geocode(liveShortCode, {
      limit: 1,
      lang: 'en',
      in: 'countryCode:SAU',
      types: 'address',
    });

    expect(Array.isArray(geocodeResult.items)).toBe(true);
    expect(geocodeResult.items.length).toBeGreaterThan(0);

    const item = geocodeResult.items[0];
    expect(item).toHaveProperty('position');
    expect(item.position).toHaveProperty('lat');
    expect(item.position).toHaveProperty('lng');

    const address = item.address || {};
    expect((address.city || address.county || address.state || address.label || '').length).toBeGreaterThan(0);
    expect((address.district || address.subdistrict || address.label || '').length).toBeGreaterThan(0);
  });
});
