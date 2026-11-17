const {
  inferExpectedSurfaceIds,
  isExplicitlyOptional,
  isMeaningfulRequirement,
  parseBulletItems,
  parseIssueAuditContract,
  remediationOriginalIssueNumber,
} = require('../../../scripts/ops/audit/issue-contract');

describe('done audit issue contract parsing', () => {
  test('parses required deliverables, tests, docs, and surfaces sections', () => {
    const parsed = parseIssueAuditContract([
      '## Surfaces / Systems',
      'Console, Portal, backend workflow',
      '',
      '## Required deliverables',
      '- Console wiring',
      '- Portal wiring',
      '',
      '## Required tests',
      '- test:unit',
      '- test:integration',
      '',
      '## Required docs',
      '- docs/ops/runbooks/example.md',
      '',
      '## Definition of done',
      '- merged to dev',
    ].join('\n'));

    expect(parsed.surfaces).toContain('Console');
    expect(parsed.requiredDeliverables).toContain('Console wiring');
    expect(parsed.requiredTests).toContain('test:integration');
    expect(parsed.requiredDocs).toContain('docs/ops/runbooks/example.md');
    expect(parsed.definitionOfDone).toContain('merged to dev');
  });

  test('infers expected surfaces from issue sections and primary surface text', () => {
    expect(inferExpectedSurfaceIds('Console, Portal, backend workflow', 'fieldops/mobile')).toEqual([
      'db',
      'console',
      'portal',
      'mobile_fieldops',
    ]);
  });

  test('treats explicit no-docs markers as optional', () => {
    expect(isExplicitlyOptional('No docs')).toBe(true);
    expect(isMeaningfulRequirement('No docs')).toBe(false);
    expect(isMeaningfulRequirement('- Update runbook')).toBe(true);
  });

  test('extracts bullet items from markdown sections', () => {
    expect(parseBulletItems('- one\n- two\n3. three')).toEqual(['one', 'two', 'three']);
  });

  test('parses remediation issue original issue references', () => {
    expect(remediationOriginalIssueNumber('Original-Issue: #4242')).toBe(4242);
  });
});
