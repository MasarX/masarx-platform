'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  scanFile,
  isExempt,
} = require('../../../scripts/qa/state-of-art/scan-raw-type-literals.js');

describe('scan-raw-type-literals', () => {
  test('scanFile finds fontSize and lineHeight literals in synthetic content', () => {
    const tmp = path.join(os.tmpdir(), `scan-test-${Date.now()}-${process.pid}.tsx`);
    fs.writeFileSync(
      tmp,
      'const s = StyleSheet.create({ a: { fontSize: 14, lineHeight: 20 } });'
    );
    try {
      const findings = scanFile(tmp);
      expect(findings.length).toBe(2);
      expect(findings.find((f) => f.prop === 'fontSize').raw_value).toBe('14');
      expect(findings.find((f) => f.prop === 'lineHeight').raw_value).toBe('20');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('isExempt skips theme/policy/test/types files', () => {
    expect(isExempt('apps/fieldops/src/mobile-theme.ts')).toBe(true);
    expect(isExempt('apps/fieldops/src/status-theme-policy.ts')).toBe(true);
    expect(isExempt('tests/unit/foo.test.tsx')).toBe(true);
    expect(isExempt('apps/fieldops/src/components/Foo.types.ts')).toBe(true);
    expect(isExempt('apps/fieldops/src/__mocks__/something.ts')).toBe(true);
  });

  test('isExempt does NOT skip regular source files', () => {
    expect(isExempt('apps/fieldops/src/components/Foo.tsx')).toBe(false);
    expect(isExempt('apps/fieldops/App.tsx')).toBe(false);
    expect(isExempt('apps/fieldops/src/screens/HomeScreen.tsx')).toBe(false);
  });
});
