// capabilities.test.ts — alignment vitest for src/lib/capabilities.ts.
//
// Asserts:
//   1. Every CAP.* literal exists in the seed-raw/registry.js capabilities
//      array (no FE-side capability is invented outside the SSOT).
//   2. Every seed-raw capability is exposed via CAP.* (no key is registered
//      in the SSOT but missing from the typed bridge — that would let
//      modules silently miss a real capability).
//   3. The `isCapability` runtime guard accepts every registered key and
//      rejects unknown ones.
//   4. The `CAPABILITY_KEYS` and `CAPABILITY_SET` runtime exports stay in
//      sync (Set built from the array).
//
// This test pairs with `apps/console-v2/scripts/lint-capabilities.mjs`,
// which enforces alignment between seed-raw and the backend
// access_control_policy / rbac_permission registries. With both gates
// green, the capability key set is a strict three-way SSOT chain:
//   backend ↔ seed-raw ↔ src/lib/capabilities.ts

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CAP,
  CAPABILITY_KEYS,
  CAPABILITY_SET,
  hasWildcardCapability,
  isCapability,
  isWildcardCapability,
} from '../capabilities';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import { capabilities as SEED_CAPABILITIES } from '../seed-raw/registry.js';

const seedKeys = new Set<string>(SEED_CAPABILITIES as readonly string[]);
const capValues = new Set<string>(Object.values(CAP));
const capabilitiesSource = readFileSync('src/lib/capabilities.ts', 'utf8');

describe('lib/capabilities — SSOT bridge to seed-raw/registry.js', () => {
  it('every CAP.* literal exists in seed-raw registry', () => {
    const orphans: string[] = [];
    for (const key of Object.entries(CAP)) {
      const [name, value] = key;
      if (!seedKeys.has(value)) {
        orphans.push(`${name} -> ${value}`);
      }
    }
    expect(
      orphans,
      `CAP entries missing from seed-raw/registry.js capabilities: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('every seed-raw capability is exposed via CAP.*', () => {
    const missing: string[] = [];
    for (const cap of seedKeys) {
      if (!capValues.has(cap)) {
        missing.push(cap);
      }
    }
    expect(
      missing,
      `seed-raw capabilities missing from CAP: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('CAPABILITY_KEYS mirrors seed-raw capabilities (same length)', () => {
    expect(CAPABILITY_KEYS.length).toBe(seedKeys.size);
  });

  it('CAPABILITY_SET is the Set form of CAPABILITY_KEYS', () => {
    expect(CAPABILITY_SET.size).toBe(CAPABILITY_KEYS.length);
    for (const key of CAPABILITY_KEYS) {
      expect(CAPABILITY_SET.has(key)).toBe(true);
    }
  });

  it('isCapability accepts every registered key', () => {
    for (const key of CAPABILITY_KEYS) {
      expect(isCapability(key)).toBe(true);
    }
  });

  it('isCapability rejects unknown keys + null/undefined', () => {
    expect(isCapability('not.a.real.capability')).toBe(false);
    expect(isCapability('')).toBe(false);
    expect(isCapability(null)).toBe(false);
    expect(isCapability(undefined)).toBe(false);
  });

  it('CAP entries are frozen (no accidental runtime mutation)', () => {
    expect(Object.isFrozen(CAP)).toBe(true);
  });

  it('does not import seed-raw registry from the runtime capability bridge', () => {
    expect(capabilitiesSource).not.toContain("from './seed-raw/registry.js'");
    expect(capabilitiesSource).not.toContain('SEED_CAPABILITIES');
  });

  it('honors backend and legacy wildcard capability sentinels', () => {
    expect(isWildcardCapability('*')).toBe(true);
    expect(isWildcardCapability('all')).toBe(true);
    expect(isWildcardCapability('shipments.read')).toBe(false);
    expect(hasWildcardCapability(new Set(['*']))).toBe(true);
    expect(hasWildcardCapability(['all'])).toBe(true);
    expect(hasWildcardCapability(['shipments.read'])).toBe(false);
  });
});
