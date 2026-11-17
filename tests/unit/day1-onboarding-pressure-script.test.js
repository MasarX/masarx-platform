const fs = require('fs');
const path = require('path');

describe('day1 onboarding pressure script', () => {
  test('normalizes tracking/barcode token to shipment_boxes barcode constraint', () => {
    const file = path.join(__dirname, '..', '..', 'tests', 'load', 'day1-onboarding-pressure.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('function toBarcodeToken');
    expect(body).toMatch('/[^A-Z0-9]/g');
    expect(body).toMatch('function buildTrackingNumber');
    expect(body).toMatch('C${segmentClient}V${segmentVu}I${segmentIter}S${segmentSlot}T${segmentTime}');
    expect(body).toMatch('const trackingPrefix = toBarcodeToken(`DAY1-${runId}`);');
    expect(body).toMatch('const trackingNumber = buildTrackingNumber(data, tenant, slot);');
    expect(body).toMatch('const barcode = `${trackingNumber}:1`;');
  });

  test('retries teardown cleanup when session-mode max clients is reached', () => {
    const file = path.join(__dirname, '..', '..', 'tests', 'load', 'day1-onboarding-pressure.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toMatch('const DAY1_SETUP_DB_RETRY_ATTEMPTS');
    expect(body).toMatch('const DAY1_SETUP_DB_RETRY_SLEEP_MS');
    expect(body).toMatch('setup db retry');
    expect(body).toMatch('const DAY1_RUNTIME_DB_CONNECT_RETRY_ATTEMPTS');
    expect(body).toMatch('const DAY1_RUNTIME_DB_CONNECT_RETRY_SLEEP_MS');
    expect(body).toMatch('const DAY1_LABEL_HTTP_RETRY_ATTEMPTS');
    expect(body).toMatch('const DAY1_LABEL_HTTP_RETRY_SLEEP_MS');
    expect(body).toMatch('const DAY1_LABEL_FAILURE_LOG_LIMIT');
    expect(body).toMatch('runtime db open retry');
    expect(body).toMatch('label bundle failure sample');
    expect(body).toMatch('const DAY1_TEARDOWN_DB_RETRY_ATTEMPTS');
    expect(body).toMatch('const DAY1_TEARDOWN_DB_RETRY_SLEEP_MS');
    expect(body).toMatch('const DAY1_TEARDOWN_FAIL_ON_MAX_CLIENTS');
    expect(body).toMatch('function isMaxClientsError');
    expect(body).toMatch('function closeCachedConnections');
    expect(body).toMatch('/MaxClientsInSessionMode|max clients reached/i');
    expect(body).toMatch('function runTeardownQueryWithRetry');
    expect(body).toMatch('teardown db retry');
    expect(body).toMatch('teardown cleanup skipped after retries due max-clients saturation');
    expect(body).toMatch('closeCachedConnections();');
    expect(body).toMatch('teardown completed with ${cleanupSkippedStatements} skipped cleanup statement(s)');
    expect(body).toMatch('runTeardownQueryWithRetry(`DELETE FROM public.labels WHERE barcode LIKE $1`');
  });
});
