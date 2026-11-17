const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const schemaDir = path.join(__dirname, '..', 'fixtures', 'providers');
const readSchema = (file) => JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
const envelope = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', 'docs', 'providers', 'schemas', 'provider.webhooks.event.schema.json',
), 'utf8'));
const canceled = readSchema('provider.webhooks.shipment.canceled.schema.json');
const mappedCanceled = readSchema('provider.webhooks.shipment.canceled.mapped-profile.schema.json');
const mappedRescheduled = readSchema('provider.webhooks.shipment.rescheduled.mapped-profile.schema.json');
const ajv = new Ajv2020({ strictTypes: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(envelope);
const validateEnvelope = ajv.getSchema(envelope.$id);
const validateCanceled = ajv.compile(canceled);
const validateMappedCanceled = ajv.compile(mappedCanceled);
const validateMappedRescheduled = ajv.compile(mappedRescheduled);
const payload = (type) => ({
  event: { id: 'synthetic-contract-event', type },
  shipment: { tracking_number: 'SYNTHETIC-CONTRACT-001' },
});

describe('provider webhook contract profiles', () => {
  test.each(['shipment.canceled', 'shipment.cancelled'])(
    'current cancellation template accepts %s without making a reason mandatory',
    (type) => {
      const event = payload(type);
      expect(validateCanceled(event)).toBe(true);
      expect(validateMappedCanceled(event)).toBe(false);
      event.shipment.cancel_reason = '';
      expect(validateCanceled(event)).toBe(true);
      expect(validateMappedCanceled(event)).toBe(false);
    },
  );

  test('strict mapped cancellation retains non-empty reason and its selected event spelling', () => {
    const event = payload('shipment.canceled');
    event.shipment.cancel_reason = 'Synthetic test reason';
    expect(validateMappedCanceled(event)).toBe(true);
    event.shipment.cancel_reason = 42;
    expect(validateCanceled(event)).toBe(false);
    expect(validateMappedCanceled(event)).toBe(false);
    event.shipment.cancel_reason = 'Synthetic test reason';
    event.event.type = 'shipment.cancelled';
    expect(validateMappedCanceled(event)).toBe(false);
  });

  test.each(['shipment.rescheduled', 'shipment.reschedule'])(
    'base envelope accepts proven reschedule ingress %s without inventing a universal provider date requirement',
    (type) => expect(validateEnvelope(payload(type))).toBe(true),
  );

  test('strict mapped reschedule requires delivery.requested_date, not the native slot_date shape', () => {
    const event = payload('shipment.rescheduled');
    event.slot_date = '2026-10-20';
    expect(validateMappedRescheduled(event)).toBe(false);
    event.delivery = {};
    expect(validateMappedRescheduled(event)).toBe(false);
    event.delivery.requested_date = '2026-10-20';
    expect(validateMappedRescheduled(event)).toBe(true);
    event.event.type = 'shipment.reschedule';
    expect(validateMappedRescheduled(event)).toBe(false);
  });

  test.each(['', '2026-02-30', '2026-10-20T10:00:00Z', 42])(
    'strict mapped reschedule rejects invalid requested_date %p',
    (requested_date) => {
      const event = { ...payload('shipment.rescheduled'), delivery: { requested_date } };
      expect(validateMappedRescheduled(event)).toBe(false);
    },
  );

  test.each([
    ['current cancellation', validateCanceled, 'shipment.canceled'],
    ['mapped cancellation', validateMappedCanceled, 'shipment.canceled'],
    ['mapped reschedule', validateMappedRescheduled, 'shipment.rescheduled'],
  ])('%s preserves envelope and tracking validation', (_label, validate, type) => {
    const event = {
      ...payload(type),
      delivery: { requested_date: '2026-10-20' },
    };
    event.shipment.cancel_reason = 'Synthetic test reason';
    expect(validate(event)).toBe(true);
    delete event.event.id;
    expect(validate(event)).toBe(false);
    event.event.id = 'synthetic-contract-event';
    event.shipment.tracking_number = '';
    expect(validate(event)).toBe(false);
    delete event.shipment;
    expect(validate(event)).toBe(false);
  });

  test('validation does not transform requested_date, inject timezone defaults, or rewrite event names', () => {
    const event = {
      ...payload('shipment.rescheduled'),
      delivery: { requested_date: '2026-10-20' },
    };
    const before = JSON.stringify(event);
    expect(validateMappedRescheduled(event)).toBe(true);
    expect(JSON.stringify(event)).toBe(before);
  });

  test.each(['shipment_action.delete', 'shipment_action.delivery_slot_reserved', 'shipment.unknown'])(
    'rejects internal/unknown event name %s as provider ingress',
    (type) => expect(validateEnvelope(payload(type))).toBe(false),
  );
});
