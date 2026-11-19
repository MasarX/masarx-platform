const {
  parseTraceparent,
  buildTraceparent,
  resolveTraceContext,
  sanitizeLogFields,
  redactSensitiveString,
  emitTrace,
} = require('../../../scripts/ops/workspace/trace-log');

describe('workspace/trace-log', () => {
  test('parseTraceparent parses valid W3C traceparent', () => {
    const parsed = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(parsed).toEqual({
      version: '00',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      traceFlags: '01',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
  });

  test('buildTraceparent returns valid traceparent shape', () => {
    const traceparent = buildTraceparent({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      traceFlags: '01',
    });
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  test('resolveTraceContext preserves upstream trace id and generates span id', () => {
    const ctx = resolveTraceContext({
      operation: 'workspace.test',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(ctx.operation).toBe('workspace.test');
    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  test('emitTrace writes structured JSON payload', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = resolveTraceContext({ operation: 'workspace.test.emit' });
    const event = emitTrace(ctx, 'info', { step: 'unit', status: 'ok' });
    expect(event).toEqual(
      expect.objectContaining({
        level: 'info',
        operation: 'workspace.test.emit',
        step: 'unit',
        status: 'ok',
      }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(spy.mock.calls[0][0]);
    expect(payload.trace_id).toBe(ctx.traceId);
    expect(payload.span_id).toBe(ctx.spanId);
    spy.mockRestore();
  });

  test('sanitizeLogFields redacts sensitive keys recursively', () => {
    const sanitized = sanitizeLogFields({
      token: 'abc123',
      nested: {
        password: 'p@ss',
        values: [{ authorization: 'Bearer secret' }],
      },
      safe: 'ok',
    });

    expect(sanitized.token).toBe('[REDACTED]');
    expect(sanitized.nested.password).toBe('[REDACTED]');
    expect(sanitized.nested.values[0].authorization).toBe('[REDACTED]');
    expect(sanitized.safe).toBe('ok');
  });

  test('redactSensitiveString masks bearer, basic, jwt-like and credential URLs', () => {
    const input = [
      'Authorization: Bearer abc.def.ghi',
      ['Authorization: Basic ', 'dXNlcjpz', 'ZWNyZXQ='].join(''),
      ('jwt ' + [Buffer.from("{\"alg\":\"HS256\",\"typ\":\"JWT\"}").toString("base64url"),Buffer.from("{\"sub\":\"1\"}").toString("base64url"),"signaturehere"].join(".")),
      (['postgres',":","/","/",'user',":",'fake-db-password',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
    ].join(' | ');

    const output = redactSensitiveString(input, '[MASKED]');
    expect(output).toContain('Bearer [MASKED]');
    expect(output).toContain('Basic [MASKED]');
    expect(output).not.toContain('fake-db-password');
    expect(output).toContain((['postgres',":","/","/",'user',":",'[MASKED]',"@",'example.invalid',":",'5432',"/",'postgres'].join("")));
  });

  test('emitTrace prevents reserved trace fields from being overridden', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = resolveTraceContext({ operation: 'workspace.test.context' });
    emitTrace(ctx, 'info', {
      operation: 'evil.operation',
      trace_id: 'deadbeef',
      span_id: 'deadbeef',
      trace_flags: '00',
      traceparent: '00-deadbeefdeadbeefdeadbeefdeadbeef-deadbeefdeadbeef-00',
      step: 'still_kept',
    });

    const payload = JSON.parse(spy.mock.calls[0][0]);
    expect(payload.operation).toBe('workspace.test.context');
    expect(payload.trace_id).toBe(ctx.traceId);
    expect(payload.span_id).toBe(ctx.spanId);
    expect(payload.trace_flags).toBe(ctx.traceFlags);
    expect(payload.traceparent).toBe(ctx.traceparent);
    expect(payload.step).toBe('still_kept');
    spy.mockRestore();
  });

  test('sanitizeLogFields redacts from custom key patterns', () => {
    const sanitized = sanitizeLogFields(
      {
        clientCredential: 's3cr3t',
        plain: 'ok',
      },
      { redactKeys: 'clientCredential' },
    );
    expect(sanitized.clientCredential).toBe('[REDACTED]');
    expect(sanitized.plain).toBe('ok');
  });
});
