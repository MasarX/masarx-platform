import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Console V2 edges are logical so they mirror under dir="rtl" without overrides (#382).
// A declaration that must stay physical carries a `/* physical: <why> */` comment on its line.
const STYLES_DIR = dirname(fileURLToPath(import.meta.url));
const PHYSICAL_EDGE =
  /(?<![-\w])(left|right)\s*:|(margin|padding|border)-(left|right)|text-align:\s*(left|right)\b|border-(top|bottom)-(left|right)-radius/;

describe('Console V2 stylesheet edges', () => {
  it('use logical properties unless a line documents why it stays physical', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(STYLES_DIR).filter((name) => name.endsWith('.css'))) {
      readFileSync(join(STYLES_DIR, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (PHYSICAL_EDGE.test(line) && !line.includes('/* physical: ')) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
