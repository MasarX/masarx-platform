const {
  normalizeUuid,
  uuidToTraceId,
  traceIdToUuid,
  resolveCorrelationId,
  resolveExecutionContext,
  buildTraceHeaders,
  emitTraceWithContext,
} = require('../../../scripts/utils/trace-context');

describe('scripts/utils/trace-context', () => {
  test('normalizeUuid accepts canonical uuid and hex uuid', () => {
    expect(normalizeUuid('99990000-0000-0000-0000-000000000049')).toBe('99990000-0000-0000-0000-000000000049');
    expect(normalizeUuid('99990000000000000000000000000049')).toBe('99990000-0000-0000-0000-000000000049');
    expect(normalizeUuid('nope')).toBeNull();
  });

  test('uuidToTraceId / traceIdToUuid roundtrip', () => {
    const uuid = '99990000-0000-0000-0000-000000000049';
    const traceId = uuidToTraceId(uuid);
    expect(traceId).toBe('99990000000000000000000000000049');
    expect(traceIdToUuid(traceId)).toBe(uuid);
  });

  test('resolveCorrelationId prefers explicit correlationId', () => {
    expect(resolveCorrelationId({ correlationId: '99990000-0000-0000-0000-000000000049' }))
      .toBe('99990000-0000-0000-0000-000000000049');
  });

  test('resolveCorrelationId derives from traceparent when correlationId is missing', () => {
    const corr = resolveCorrelationId({
      traceparent: '00-99990000000000000000000000000049-00f067aa0ba902b7-01',
    });
    expect(corr).toBe('99990000-0000-0000-0000-000000000049');
  });

  test('resolveExecutionContext uses uuid-derived trace id by default', () => {
    const previous = process.env.TRACEPARENT;
    delete process.env.TRACEPARENT;
    try {
      const ctx = resolveExecutionContext({
        operation: 'unit.test',
        correlationId: '99990000-0000-0000-0000-000000000049',
      });
      expect(ctx.correlationId).toBe('99990000-0000-0000-0000-000000000049');
      expect(ctx.traceId).toBe('99990000000000000000000000000049');
      expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(ctx.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    } finally {
      if (previous === undefined) delete process.env.TRACEPARENT;
      else process.env.TRACEPARENT = previous;
    }
  });

  test('buildTraceHeaders includes x-correlation-id and traceparent', () => {
    const ctx = resolveExecutionContext({
      operation: 'unit.headers',
      correlationId: '99990000-0000-0000-0000-000000000049',
    });
    expect(buildTraceHeaders(ctx)).toEqual({
      'x-correlation-id': '99990000-0000-0000-0000-000000000049',
      traceparent: ctx.traceparent,
    });
  });

  test('emitTraceWithContext logs JSON and preserves correlation_id', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = resolveExecutionContext({
      operation: 'unit.emit',
      correlationId: '99990000-0000-0000-0000-000000000049',
    });
    const record = emitTraceWithContext(ctx, 'info', { event: 'unit_event' });

    expect(record).toEqual(expect.objectContaining({ correlation_id: ctx.correlationId, event: 'unit_event' }));
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(spy.mock.calls[0][0]);
    expect(payload.correlation_id).toBe(ctx.correlationId);
    expect(payload.traceparent).toBe(ctx.traceparent);
    spy.mockRestore();
  });
});

