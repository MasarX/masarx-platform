const path = require('path');

/**
 * verify-cloud-core-steps.js
 *
 * SSOT for step planning helpers used by verify-cloud-core.js.
 * Keep verify behavior dynamic and toggleable (CI speed vs. safety)
 * without duplicating step definitions across workflows.
 */

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function shouldParallelizePgtapIntegration(env = process.env, platform = process.platform) {
  void platform;
  if (!isTruthy(env.VERIFY_CORE_PARALLEL_PGTAP_INTEGRATION)) return false;
  return true;
}

function planPgtapIntegrationSteps({
  npmCmd,
  parallelize,
  includePgtap = true,
  includeIntegration = true,
}) {
  const nodeCmd = process.execPath || 'node';
  const pgtap = {
    cmd: nodeCmd,
    args: [path.join('scripts', 'tests', 'run-pgtap-cloud.js')],
    label: 'test:pgtap',
    logFile: 'pgtap.log',
    qaSuiteKey: 'pgtap',
  };
  const integration = {
    cmd: nodeCmd,
    args: [path.join('scripts', 'tests', 'run-integration-cloud.js')],
    label: 'test:integration:cloud',
    logFile: 'jest.log',
    qaSuiteKey: 'jest:integration',
  };

  const planned = [];
  if (includePgtap) planned.push(pgtap);
  if (includeIntegration) planned.push(integration);

  if (parallelize && planned.length > 1) {
    return [
      {
        type: 'parallel',
        label: 'test:pgtap+integration',
        steps: planned,
      },
    ];
  }

  return planned;
}

module.exports = {
  shouldParallelizePgtapIntegration,
  planPgtapIntegrationSteps,
};
