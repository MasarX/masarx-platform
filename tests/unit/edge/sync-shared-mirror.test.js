const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('Edge shared mirror preserves matching files and replaces divergent entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-shared-mirror-'));
  try {
    const script = path.join(root, 'scripts', 'edge', 'sync-shared.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../../scripts/edge/sync-shared.js'), script);
    fs.copyFileSync(path.resolve(__dirname, '../../../scripts/edge/shared-layout.cjs'), path.join(path.dirname(script), 'shared-layout.cjs'));

    const functions = path.join(root, 'supabase', 'functions');
    const source = path.join(functions, '_shared');
    const target = path.join(functions, 'fixture', '_shared');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(source, 'nested', 'module.ts'), 'before');
    fs.writeFileSync(path.join(source, 'replace.ts'), 'canonical');
    fs.writeFileSync(path.join(source, 'Name.ts'), 'module');
    fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
    fs.symlinkSync(outside, path.join(target, 'replace.ts'), 'junction');
    fs.writeFileSync(path.join(target, 'stale'), 'remove');
    fs.writeFileSync(path.join(target, 'name.ts'), 'module');

    const sync = () => execFileSync(process.execPath, [script, '--if-present'], { cwd: root });
    sync();
    expect(fs.lstatSync(path.join(target, 'replace.ts')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(target, 'replace.ts'), 'utf8')).toBe('canonical');
    expect(fs.readdirSync(target).sort()).toEqual(['Name.ts', 'nested', 'replace.ts']);
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('untouched');

    const unchanged = path.join(target, 'replace.ts');
    const fixedTime = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(unchanged, fixedTime, fixedTime);
    fs.writeFileSync(path.join(source, 'nested', 'module.ts'), 'update');
    sync();

    expect(fs.statSync(unchanged).mtimeMs).toBe(fixedTime.getTime());
    expect(fs.readFileSync(path.join(target, 'nested', 'module.ts'), 'utf8')).toBe('update');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
