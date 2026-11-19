// Unit coverage for the condition-builder model. We deliberately keep this
// purely functional (no React) so we can lock the JSONLogic emit shape and the
// pass/fail evaluator for every operator.

import { describe, expect, it } from 'vitest';
import {
  discoverFields,
  evalCondition,
  fromLegacyFlat,
  inferType,
  makeGroup,
  makeLeaf,
  operatorsFor,
  summarize,
  toJsonLogic,
  toLegacyFlatIfPossible,
  validate,
  valueSamples,
} from './condition-model';

describe('condition-model: type inference + operators', () => {
  it('infers number from integer samples', () => {
    expect(inferType([1, 2, 3])).toBe('number');
  });
  it('infers string from string samples', () => {
    expect(inferType(['a', 'b'])).toBe('string');
  });
  it('infers boolean from boolean samples', () => {
    expect(inferType([true, false])).toBe('boolean');
  });
  it('returns unknown for mixed types', () => {
    expect(inferType(['a', 1, true])).toBe('unknown');
  });
  it('narrows operators by type', () => {
    expect(operatorsFor('number')).toContain('gt');
    expect(operatorsFor('number')).not.toContain('matches');
    expect(operatorsFor('boolean')).toContain('equals');
    expect(operatorsFor('string')).toContain('matches');
  });
});

describe('condition-model: legacy round-trip', () => {
  it('imports flat shape into AND of equals leaves', () => {
    const root = fromLegacyFlat({ sender: 'exampleparcel', cod: 0 });
    expect(root.combinator).toBe('and');
    expect(root.children.length).toBe(2);
    expect(root.children[0]).toMatchObject({ kind: 'leaf', op: 'equals', field: 'payload.sender' });
  });

  it('emits flat shape only when tree is AND of equals', () => {
    const root = makeGroup('and');
    root.children = [
      { kind: 'leaf', field: 'payload.sender', op: 'equals', value: 'exampleparcel' },
      { kind: 'leaf', field: 'payload.cod', op: 'equals', value: '0' },
    ];
    expect(toLegacyFlatIfPossible(root)).toEqual({ sender: 'exampleparcel', cod: 0 });
  });

  it('returns null when tree is not flat AND-equals', () => {
    const root = makeGroup('or');
    root.children = [makeLeaf()];
    expect(toLegacyFlatIfPossible(root)).toBeNull();
  });
});

describe('condition-model: jsonlogic emit', () => {
  it('emits == for equals', () => {
    const leaf = { kind: 'leaf' as const, field: 'payload.sender', op: 'equals' as const, value: 'exampleparcel' };
    expect(toJsonLogic(leaf)).toEqual({ '==': [{ var: 'payload.sender' }, 'exampleparcel'] });
  });
  it('emits > for gt with numeric coercion', () => {
    const leaf = { kind: 'leaf' as const, field: 'payload.cod', op: 'gt' as const, value: '100' };
    expect(toJsonLogic(leaf)).toEqual({ '>': [{ var: 'payload.cod' }, 100] });
  });
  it('emits in with array coercion from CSV', () => {
    const leaf = { kind: 'leaf' as const, field: 'payload.sender', op: 'in' as const, value: 'exampleparcel, examplemart' };
    expect(toJsonLogic(leaf)).toEqual({ in: [{ var: 'payload.sender' }, ['exampleparcel', 'examplemart']] });
  });
  it('emits regex_match for matches', () => {
    const leaf = { kind: 'leaf' as const, field: 'payload.tracking_number', op: 'matches' as const, value: '^EXAMPLEMARKET-' };
    expect(toJsonLogic(leaf)).toEqual({ regex_match: [{ var: 'payload.tracking_number' }, '^EXAMPLEMARKET-'] });
  });
  it('emits and / or / not for groups', () => {
    const tree = {
      kind: 'group' as const,
      combinator: 'or' as const,
      children: [
        { kind: 'leaf' as const, field: 'payload.sender', op: 'equals' as const, value: 'exampleparcel' },
        {
          kind: 'group' as const,
          combinator: 'not' as const,
          children: [{ kind: 'leaf' as const, field: 'payload.cod', op: 'gt' as const, value: '0' }],
        },
      ],
    };
    expect(toJsonLogic(tree)).toEqual({
      or: [
        { '==': [{ var: 'payload.sender' }, 'exampleparcel'] },
        { '!': { '>': [{ var: 'payload.cod' }, 0] } },
      ],
    });
  });
});

describe('condition-model: evaluator parity', () => {
  const payload = { sender: 'exampleparcel', cod: 250, tracking_number: 'EXAMPLEMARKET-99281', flag: true };
  it('evaluates equals + gt + matches', () => {
    expect(evalCondition({ kind: 'leaf', field: 'payload.sender', op: 'equals', value: 'exampleparcel' }, payload)).toBe(true);
    expect(evalCondition({ kind: 'leaf', field: 'payload.cod', op: 'gt', value: '100' }, payload)).toBe(true);
    expect(evalCondition({ kind: 'leaf', field: 'payload.tracking_number', op: 'matches', value: '^EXAMPLEMARKET-' }, payload)).toBe(true);
  });
  it('evaluates exists + not_exists', () => {
    expect(evalCondition({ kind: 'leaf', field: 'payload.sender', op: 'exists', value: '' }, payload)).toBe(true);
    expect(evalCondition({ kind: 'leaf', field: 'payload.missing', op: 'not_exists', value: '' }, payload)).toBe(true);
  });
  it('evaluates in + not_in', () => {
    expect(evalCondition({ kind: 'leaf', field: 'payload.sender', op: 'in', value: 'exampleparcel, examplemart' }, payload)).toBe(true);
    expect(evalCondition({ kind: 'leaf', field: 'payload.sender', op: 'not_in', value: 'examplemart' }, payload)).toBe(true);
  });
  it('honors AND / OR / NOT semantics', () => {
    const orTree = makeGroup('or');
    orTree.children = [
      { kind: 'leaf', field: 'payload.sender', op: 'equals', value: 'examplemart' },
      { kind: 'leaf', field: 'payload.cod', op: 'gt', value: '0' },
    ];
    expect(evalCondition(orTree, payload)).toBe(true);

    // makeGroup only accepts and|or; build NOT manually to test inversion.
    const notTree = {
      kind: 'group' as const,
      combinator: 'not' as const,
      children: [{ kind: 'leaf' as const, field: 'payload.sender', op: 'equals' as const, value: 'exampleparcel' }],
    };
    expect(evalCondition(notTree, payload)).toBe(false);
  });
});

describe('condition-model: validation', () => {
  it('flags numeric value required for gt', () => {
    const leaf = { kind: 'leaf' as const, field: 'payload.cod', op: 'gt' as const, value: 'abc' };
    const root = makeGroup('and');
    root.children = [leaf];
    const issues = validate(root);
    const numErr = issues.find((i) => i.message.toLowerCase().includes('numeric'));
    expect(numErr).toBeTruthy();
    expect(numErr?.severity).toBe('error');
  });
  it('warns on empty value', () => {
    const root = makeGroup('and');
    root.children = [{ kind: 'leaf', field: 'payload.sender', op: 'equals', value: '' }];
    const issues = validate(root);
    expect(issues.some((i) => i.severity === 'warn')).toBe(true);
  });
  it('flags invalid regex', () => {
    const root = makeGroup('and');
    root.children = [{ kind: 'leaf', field: 'payload.x', op: 'matches', value: '(' }];
    const issues = validate(root);
    expect(issues.some((i) => i.message.toLowerCase().includes('regex'))).toBe(true);
  });
});

describe('condition-model: discovery + samples', () => {
  const events = [
    { payload: { sender: 'exampleparcel', cod: 200 } },
    { payload: { sender: 'examplemart', cod: 0, flag: true } },
  ];
  it('discovers union of payload keys with payload. prefix', () => {
    expect(discoverFields(events)).toEqual(['payload.cod', 'payload.flag', 'payload.sender']);
  });
  it('returns samples for a field', () => {
    expect(valueSamples('payload.cod', events)).toEqual([200, 0]);
    expect(valueSamples('payload.flag', events)).toEqual([true]);
  });
});

describe('condition-model: summarize', () => {
  it('produces human-readable AND summary', () => {
    const root = fromLegacyFlat({ sender: 'exampleparcel', cod: '0' });
    expect(summarize(root)).toContain('AND');
    expect(summarize(root)).toContain('payload.sender');
  });
  it('handles empty tree', () => {
    const empty = makeGroup('and');
    empty.children = [];
    expect(summarize(empty)).toBe('— always —');
  });
});
