const fs = require('fs');
const path = require('path');

describe('scripts/ops/branches/create.js', () => {
  test('syncs DB password when reusing an existing project', () => {
    const body = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'branches', 'create.js'),
      'utf8',
    );

    expect(body).toContain('setProjectDatabasePassword');
    expect(body).toContain('if (created.reused) {');
    expect(body).toContain('await setProjectDatabasePassword({');
    expect(body).toContain('resolveProjectPoolerHost');
    expect(body).toContain('pooler_host');
  });
});
