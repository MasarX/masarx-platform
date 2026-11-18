import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApiGatewayRoutePayloadTemplate } from '../_api-gateway.payload';

describe('api gateway route payload templates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds editable shipment payloads from row-driven route extract policy', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T10:00:00.000Z'));
    const payload = buildApiGatewayRoutePayloadTemplate(
      {
        policy: {
          postprocess: {
            extract: {
              recipient_name_path: 'pkg.receiverName',
              recipient_phone_path: 'pkg.receiverPhone|pkg.receiverPhone2',
              client_reference_path: 'pkg.invoiceNumber|pkg.supplierInvoice',
              cod_amount_path: 'pkg.toCollectFromReceiver|pkg.cod',
              box_count_path: 'pkg.quantity',
              service_type_path: 'pkg.shipmentType',
              destination_city_path: 'destinationAddress.city|destinationAddress.arabicCityName',
              destination_line1_path: 'destinationAddress.addressLine1|destinationAddress.street',
              destination_country_path: 'destinationAddress.country',
              promised_delivery_date_path: 'expectedDeliveryDate|data.expectedDeliveryDate',
            },
          },
        },
      },
      'corr-test-123',
    );

    expect(payload).toMatchObject({
      pkg: {
        receiverName: 'API Gateway Recipient',
        receiverPhone: '+12025550123',
        invoiceNumber: 'API-CORRTEST123',
        toCollectFromReceiver: 25.5,
        quantity: 1,
        shipmentType: 'delivery',
      },
      destinationAddress: {
        city: 'Riyadh',
        addressLine1: 'API Gateway Destination Tower',
        country: 'SA',
      },
      expectedDeliveryDate: '2026-05-13',
    });
  });

  it('returns an empty object when a route has no backend mapping policy', () => {
    expect(buildApiGatewayRoutePayloadTemplate({ policy: {} }, 'corr')).toEqual({});
  });

  it('builds editable mutation payloads from update and cancel route extract policy', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T10:00:00.000Z'));
    const payload = buildApiGatewayRoutePayloadTemplate(
      {
        policy: {
          postprocess: {
            mode: 'shipment_cancel_v1',
            extract: {
              shipment_id_path: 'pkg.shipmentId',
              provider_tracking_number_path: 'pkg.trackingNumber',
              status_path: 'pkg.status',
              cancel_reason_path: 'pkg.reason',
              reschedule_date_path: 'pkg.rescheduleDate',
            },
          },
        },
      },
      'corr-mut-456',
    );

    expect(payload).toMatchObject({
      pkg: {
        shipmentId: 'SHIP-CORRMUT456',
        trackingNumber: 'TRK-CORRMUT456',
        status: 'cancelled',
        reason: 'Console API Gateway mutation proof',
        rescheduleDate: '2026-05-14',
      },
    });
  });
});
