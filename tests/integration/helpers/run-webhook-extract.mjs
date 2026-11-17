import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(baseDir, '../../../supabase/functions/_shared/mod.mjs'),
  path.resolve(baseDir, '../../../supabase/functions/webhook-receiver/_shared/mod.mjs'),
];
const input = JSON.parse(process.argv[2] || '{}');
const url = input.url || 'https://example.test/webhook';
const req = new Request(url, {
  method: input.method || 'POST',
  headers: input.headers || {},
});

let extractToken;
for (const candidate of candidates) {
  try {
    if (!fs.existsSync(candidate)) continue;
    ({ extractToken } = await import(pathToFileURL(candidate).href));
    if (typeof extractToken === 'function') break;
  } catch (_err) {
    extractToken = null;
  }
}

if (!extractToken) {
  throw new Error('Unable to resolve webhook shared extractToken module');
}

const token = extractToken(req);

console.log(JSON.stringify({ token }));
