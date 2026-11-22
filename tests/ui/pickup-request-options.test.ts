import { buildPickupRequestOptions } from '../../packages/ui/src/pickup-page-shared';

jest.mock('@masarx/api/server', () => ({}));
jest.mock('@masarx/auth/server', () => ({}));

it('uses the carrier reference when the tracking and client references are absent', () => {
  expect(buildPickupRequestOptions([{ shipment_id: 'shipment-a', carrier_reference_number: 'carrier-example' }]))
    .toEqual([{ value: 'shipment-a', label: 'carrier-example', searchText: 'carrier-example' }]);
});
