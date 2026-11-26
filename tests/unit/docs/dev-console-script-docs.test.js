const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const DOCS = ['docs/guides/TESTING_GUIDE.md', 'docs/frontend/ARCHITECTURE.md', 'docs/guides/LOCAL_SETUP.md'];

describe('dev:console docs match the root scripts (#161)', () => {
  const scripts = JSON.parse(read('package.json')).scripts;

  test('dev:console starts the Next.js console and dev:console:v2 starts Console V2', () => {
    expect(scripts['dev:console']).toMatch(/--prefix apps\/console run dev/);
    expect(scripts['dev:console:v2']).toMatch(/--prefix apps\/console-v2 run dev/);
  });

  test.each(DOCS)('%s never describes bare dev:console as Console V2', (rel) => {
    // The clause after a bare `dev:console` (not :v2 or :legacy) runs to the end of its sentence or line.
    const clauses = [...read(rel).matchAll(/dev:console(?![:\w-])([^\n]*?)(?:\.\s|\n|$)/g)].map((m) => m[1]);
    for (const clause of clauses) {
      expect(clause).not.toMatch(/Console V2|console-v2|Vite|5175/i);
    }
  });
});
