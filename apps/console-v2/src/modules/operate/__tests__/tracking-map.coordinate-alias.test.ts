import { describe, expect, it } from 'vitest';
import { resolveTrackingGeocodeCoordinates } from '@/modules/operate/tracking-map';

describe('TrackingMapModule geocode coordinate aliases', () => {
  it('accepts api.geocodes lat/lng aliases for map-ready backend readback', () => {
    expect(
      resolveTrackingGeocodeCoordinates({
        id: 'geo-api-alias',
        lat: '24.71360',
        lng: '46.67530',
      }),
    ).toEqual({ lat: 24.7136, lng: 46.6753 });
  });

  it('continues to accept latitude/longitude projection aliases', () => {
    expect(
      resolveTrackingGeocodeCoordinates({
        id: 'geo-projection-alias',
        latitude: 24.7136,
        longitude: 46.6753,
      }),
    ).toEqual({ lat: 24.7136, lng: 46.6753 });
  });

  it('fails closed instead of plotting invalid coordinates', () => {
    expect(
      resolveTrackingGeocodeCoordinates({
        id: 'geo-invalid',
        lat: 120,
        lng: 46.6753,
      }),
    ).toBeNull();
  });
});
