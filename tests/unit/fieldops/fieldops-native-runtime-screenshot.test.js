const {
  normalizeAdbPngBuffer,
  runCommand,
} = require('../../../scripts/qa/capture-fieldops-ui-screenshots-native-runtime');

describe('FieldOps native runtime screenshot capture', () => {
  test('preserves valid PNG bytes returned by adb exec-out', () => {
    const png = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1,
    ]);

    expect(normalizeAdbPngBuffer(png)).toBe(png);
  });

  test('normalizes legacy CRLF-expanded screenshot bytes only when the PNG signature is absent', () => {
    const expanded = Buffer.from([1, 13, 10, 2, 13, 10, 3]);
    expect(normalizeAdbPngBuffer(expanded)).toEqual(Buffer.from([1, 10, 2, 10, 3]));
  });

  test('honors null encoding for binary command output', () => {
    const binary = Buffer.from([137, 80, 78, 71]);
    const stdout = runCommand(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.from([137,80,78,71]))'],
      { encoding: null },
    );

    expect(Buffer.isBuffer(stdout)).toBe(true);
    expect(stdout).toEqual(binary);
  });
});
