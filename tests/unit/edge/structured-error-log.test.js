const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('structured Edge exceptions retain correlation and controlled error details', async () => {
  const modulePath = path.resolve(__dirname, '../../../supabase/functions/_shared/mod.mjs');
  const { buildStructuredLogRecord } = await import(pathToFileURL(modulePath).href);
  const requestId = randomUUID();
  const traceId = randomUUID().replaceAll('-', '');
  const inputLabel = ['generated', 'sample', 'label'].join(' ');
  const message = `Request timeout for ${inputLabel}`;
  const errors = [message, new Error(message), { message, code: inputLabel, status: '503' }];

  for (const error of errors) {
    const record = buildStructuredLogRecord('error', 'request.failed', {
      service: 'test',
      environment: 'test',
      version: 'test',
      request_id: requestId,
      trace_id: traceId,
      error,
    });

    expect(record).toMatchObject({
      request_id: requestId,
      trace_id: traceId,
      error_type: 'timeout',
      error_message: 'timeout',
    });
    expect(record.error_status).toBe(typeof error.status === 'string' ? 503 : undefined);
    expect(record).not.toHaveProperty('error_stack');
    expect(record).not.toHaveProperty('error_code');
    expect(JSON.stringify(record)).not.toContain(inputLabel);
  }
});
