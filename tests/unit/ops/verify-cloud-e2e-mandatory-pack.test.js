const {
  requireAbsoluteUrl,
  resolveSeedShipmentsPerClient,
  collectMandatoryOutcomes,
  mandatorySpecs,
} = require('../../../scripts/ops/verify-cloud-e2e-mandatory-pack');

describe('verify-cloud-e2e-mandatory-pack', () => {
  test('requireAbsoluteUrl rejects localhost hosts for mandatory gate mode', () => {
    expect(() => requireAbsoluteUrl('http://localhost:3001', 'CONSOLE_BASE_URL')).toThrow(
      /hosted URL/i,
    );
  });

  test('collectMandatoryOutcomes aggregates total, skipped, and failed outcomes', () => {
    const outcomes = collectMandatoryOutcomes({
      suites: [
        {
          title: 'root',
          specs: [
            {
              title: 'spec-a',
              tests: [
                { projectName: 'console', outcome: 'skipped' },
                { projectName: 'portal', outcome: 'unexpected' },
                { projectName: 'shared', outcome: 'expected' },
              ],
            },
          ],
        },
      ],
    });

    expect(outcomes.total).toBe(3);
    expect(outcomes.skipped).toHaveLength(1);
    expect(outcomes.failed).toHaveLength(1);
    expect(outcomes.skipped[0]).toContain('[console]');
    expect(outcomes.failed[0]).toContain('[portal]');
  });

  test('mandatorySpecs includes shipment, print, role matrix, and workflow log suites', () => {
    expect(mandatorySpecs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('action-shipments-actions.spec.ts'),
        expect.stringContaining('action-shipments-print-labels.spec.ts'),
        expect.stringContaining('console-role-matrix.spec.ts'),
        expect.stringContaining('portal-role-matrix.spec.ts'),
        expect.stringContaining('logging.workflow-run-logs-capture.spec.ts'),
      ]),
    );
  });

  test('resolveSeedShipmentsPerClient defaults to two and supports positive override', () => {
    const original = process.env.E2E_SEED_SHIPMENTS_PER_CLIENT;
    process.env.E2E_SEED_SHIPMENTS_PER_CLIENT = '';
    expect(resolveSeedShipmentsPerClient()).toBe('2');
    process.env.E2E_SEED_SHIPMENTS_PER_CLIENT = '4';
    expect(resolveSeedShipmentsPerClient()).toBe('4');
    process.env.E2E_SEED_SHIPMENTS_PER_CLIENT = '0';
    expect(resolveSeedShipmentsPerClient()).toBe('2');
    if (original == null) delete process.env.E2E_SEED_SHIPMENTS_PER_CLIENT;
    else process.env.E2E_SEED_SHIPMENTS_PER_CLIENT = original;
  });
});
