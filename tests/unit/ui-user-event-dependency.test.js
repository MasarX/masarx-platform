const pkg = require('../../package.json');

describe('ui test dependencies', () => {
  test('includes @testing-library/user-event in root devDependencies', () => {
    expect(pkg).toBeTruthy();
    expect(pkg.devDependencies).toBeTruthy();
    expect(pkg.devDependencies['@testing-library/user-event']).toBeTruthy();
  });
});

