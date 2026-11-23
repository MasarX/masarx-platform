'use strict';

const { appendFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');

module.exports = class DevE2EReporter {
  constructor({ specs, reportPath, summaryPath }) {
    this.specs = new Map(specs.map(spec => [spec, { spec, passed: 0, failed: 0, skipped: 0, incomplete: 0 }]));
    this.reportPath = reportPath;
    this.summaryPath = summaryPath;
  }

  onBegin(_config, suite) {
    this.files = suite.suites.flatMap(project => project.suites);
  }

  onEnd(result) {
    for (const file of this.files ?? []) {
      const counts = this.specs.get(basename(file.location.file));
      if (!counts) continue;
      // A shared helper can declare tests for more than one spec file.
      for (const test of file.allTests()) {
        switch (test.results.at(-1)?.status) {
          case 'passed': counts.passed++; break;
          case 'failed':
          case 'timedOut': counts.failed++; break;
          case 'skipped': counts.skipped++; break;
          default: counts.incomplete++;
        }
      }
    }

    const specs = [...this.specs.values()];
    const missingSpecs = specs.filter(row => row.passed + row.failed + row.skipped + row.incomplete === 0);
    const status = result.status === 'passed' && missingSpecs.length ? 'failed' : result.status;
    const failedSpecs = specs.filter(row => row.failed > 0).map(row => row.spec);
    const summary = [
      '## DEV browser report',
      '',
      `Playwright run: **${status}**`,
      '',
      '| Spec | Passed | Failed | Skipped | Incomplete |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...specs.map(({ spec, passed, failed, skipped, incomplete }) =>
        `| \`${spec}\` | ${passed} | ${failed} | ${skipped} | ${incomplete} |`),
      '',
      `Failed specs: ${failedSpecs.map(spec => `\`${spec}\``).join(', ') || 'none'}`,
      `Specs without collected tests: ${missingSpecs.map(row => `\`${row.spec}\``).join(', ') || 'none'}`,
      '',
    ];
    appendFileSync(this.summaryPath, summary.join('\n'));
    writeFileSync(this.reportPath, `${JSON.stringify({ status, specs, failedSpecs }, null, 2)}\n`);
    return { status };
  }
};
