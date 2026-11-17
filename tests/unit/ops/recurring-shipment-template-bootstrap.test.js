const { ensureRecurringShipmentWorkflowTemplate } = require('../../../scripts/tests/bootstrap/lib/integration-fixtures');

test.each([undefined, 'f174_owned_template'])('absent recurring template inserts steps and refreshes checksum for %s', async (name) => {
  const expectedName = name === undefined ? 'recurring_shipment_create_v1' : name;
  const templateId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
  const stepIds = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const calls = [];
  const replies = [[], [{ id: templateId }], [], [{ id: stepIds[0] }], [{ id: stepIds[1] }], [{ checksum: 'checked' }]];
  const client = {
    query: jest.fn(async (sql, values) => {
      const index = calls.length;
      if (index >= replies.length) throw new Error('Unexpected bootstrap query');
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      return { rows: replies[index] };
    }),
  };
  // Recording SQL client proves helper behavior only, not native database execution.
  await expect(ensureRecurringShipmentWorkflowTemplate(client, name)).resolves.toBe(templateId);
  expect(calls).toHaveLength(6);
  expect(calls[0].sql).toContain('WHERE name = $1::text');
  expect(calls[0].values).toEqual([expectedName]);
  expect(calls[1].values).toEqual([expectedName]);
  expect(calls[1].sql).toContain('$1::text');
  expect(calls[1].sql).toContain('INSERT INTO public.workflow_templates');
  expect(calls[1].sql).toContain("'active'");
  expect(calls[1].sql).toContain("'global'");
  expect(calls[2].sql).toContain('FROM public.workflow_template_steps');
  expect(calls[2].values).toEqual([templateId]);
  const expected = [
    [0, 'reserve_shipment_identifiers', 'create_shipment', 85, 'reserve_shipment_identifiers'],
    [1, 'create_shipment', null, null, 'shipment_create'],
  ];
  expected.forEach(([sequence, operation, next, priority, handler], index) => {
    const call = calls[index + 3];
    expect(call.sql).toContain('INSERT INTO public.workflow_template_steps');
    expect(call.values).toEqual([
      templateId, sequence, operation, 'workflow', 'always', next, priority,
      JSON.stringify({ handler_key: handler, template_name: expectedName }),
      handler, 'v1',
    ]);
  });
  expect(calls[5].sql).toBe('SELECT public.workflow_refresh_steps_checksum($1::uuid, FALSE) AS checksum');
  expect(calls[5].values).toEqual([templateId]);
});

test.each([null, '', ' ', ' padded', 'padded ', 42, {}])('invalid explicit recurring template identity rejects before SQL: %p', async (name) => {
  const client = { query: jest.fn() };
  await expect(ensureRecurringShipmentWorkflowTemplate(client, name)).rejects.toThrow('Recurring template name must be a nonblank unpadded string.');
  expect(client.query).not.toHaveBeenCalled();
});
