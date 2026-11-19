import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAVIGATION_SRC = readFileSync(path.join(here, '../seed-raw/navigation.js'), 'utf8');

describe('Console V2 navigation capability gates', () => {
  it('routes bank reconciliation navigation through finance.read', () => {
    expect(NAVIGATION_SRC).toMatch(
      /key:\s*'bank-recon'[\s\S]*?route:\s*'\/finance\/bank-recon'[\s\S]*?capability:\s*'finance\.read'/,
    );
    expect(NAVIGATION_SRC).not.toMatch(
      /key:\s*'bank-recon'[\s\S]*?route:\s*'\/finance\/bank-recon'[\s\S]*?capability:\s*'finance\.write'/,
    );
  });

  it('keeps import jobs discoverable for read-only import operators', () => {
    expect(NAVIGATION_SRC).toMatch(
      /key:\s*'imports'[\s\S]*?label:\s*'Import jobs'[\s\S]*?route:\s*'\/platform\/imports'[\s\S]*?capability:\s*'imports\.read'/,
    );
    expect(NAVIGATION_SRC).not.toMatch(
      /key:\s*'imports'[\s\S]*?route:\s*'\/platform\/imports'[\s\S]*?capability:\s*'imports\.write'/,
    );
  });

  it('keeps API request intake discoverable from the integrations workspace', () => {
    expect(NAVIGATION_SRC).toMatch(
      /key:\s*'int-api-gateway'[\s\S]*?label:\s*'API request intake'[\s\S]*?route:\s*'\/insights\/api-gateway'[\s\S]*?capability:\s*'api_gateway\.read'/,
    );
  });
});
