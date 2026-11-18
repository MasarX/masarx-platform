const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../../e2e/utils/role-matrix.ts'), 'utf8');
const body = source.slice(source.indexOf('export async function ensureNavigationVisible'), source.indexOf('export async function fetchUserContext'));
const compiled = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function harness({ state = 'ready', href = '/workflows/queue', disabled = false, title = 'Policy restriction', aliases = {} } = {}) {
  const calls = [];
  const registry = { attributes: { 'data-navigation-registry-state': state } };
  const link = { visible: true, attributes: { href } };
  const item = {
    visible: true, attributes: { 'aria-disabled': String(disabled), title },
    getByRole: role => { expect(role).toBe('link'); return link; },
  };
  const nav = {
    visible: true, first() { return this; },
    getByTestId: id => {
      calls.push(id);
      expect(id).toMatch(/^navigation-section-items-/);
      const alias = aliases[id];
      const sectionItem = alias ? {
        visible: true, attributes: { 'aria-disabled': String(alias.disabled ?? disabled), title: alias.title ?? title },
        getByRole: role => { expect(role).toBe('link'); return { visible: true, attributes: { href: alias.href ?? href } }; },
      } : item;
      return { getByTestId: itemId => {
        calls.push(itemId);
        expect(itemId).toBe('navigation-item-review');
        return sectionItem;
      } };
    },
  };
  const page = { locator: selector => {
    if (selector === '[data-testid="navigation-list"]') return nav;
    if (selector === '[data-testid="navigation-pending"]') return { count: 0 };
    if (selector === '[data-navigation-registry-state]') return { ...registry, count: 1 };
    throw new Error('Unexpected selector: ' + selector);
  } };
  const assertLocator = locator => {
    const attribute = (name, value) => typeof value === 'string'
      ? locator.attributes[name] === value : value.test(locator.attributes[name] ?? '');
    return {
      toBeVisible: async () => expect(locator.visible).toBe(true),
      toHaveCount: async count => expect(locator.count).toBe(count),
      toHaveAttribute: async (name, value) => expect(attribute(name, value)).toBe(true),
      not: { toHaveAttribute: async (name, value) => expect(attribute(name, value)).toBe(false) },
    };
  };
  const exports = {};
  new Function('exports', 'expect', 'resolveCapabilitySet', 'flattenNavigationSections',
    'isResourceReadScopeAllowed', 'hasCapability', 'normalizeNavHref', compiled)(
    exports, assertLocator, values => new Set(values ?? []),
    sections => sections.flatMap(section => section.items.map(item => ({ item }))),
    () => true, (values, required) => values.has(required), href => href);
  return { page, calls, ...exports };
}

test('navigation registry must be ready before inspecting policy items', async () => {
  const h = harness({ state: 'loading' });
  await expect(h.assertNavigationMatches({ page: h.page, basePath: '', sections: [
    { id: 'workflows', items: [{ id: 'review', label: 'قائمة المراجعة', href: '/workflows/queue' }] },
  ] })).rejects.toThrow();
  expect(h.calls).toEqual([]);
});

test.each([false, true])('Arabic item uses stable identity and preserves disabled policy=%s', async disabled => {
  const h = harness({ disabled });
  await h.assertNavigationMatches({ page: h.page, basePath: '', sections: [
    { id: 'workflows', items: [{ id: 'review', label: 'قائمة المراجعة', href: '/workflows/queue',
      disabled_reason: disabled ? 'restricted' : null }] },
  ] });
  expect(h.calls).toEqual(['navigation-section-items-workflows', 'navigation-item-review']);
});

test('enabled navigation rejects a wrong destination', async () => {
  const h = harness({ href: '/wrong' });
  await expect(h.assertNavigationMatches({ page: h.page, basePath: '', sections: [
    { id: 'workflows', items: [{ id: 'review', label: 'Review', href: '/workflows/queue' }] },
  ] })).rejects.toThrow();
});

test('disabled navigation rejects missing accessible reason', async () => {
  const h = harness({ disabled: true, title: '' });
  await expect(h.assertNavigationMatches({ page: h.page, basePath: '', sections: [
    { id: 'workflows', items: [{ id: 'review', label: 'Review', href: '/workflows/queue', disabled_reason: 'restricted' }] },
  ] })).rejects.toThrow();
});

const aliasSections = [
  { id: 'workflows', items: [{ id: 'review', label: 'Review', href: '/workflows/queue' }] },
  { id: 'observability', items: [{ id: 'review', label: 'Review history', href: '/observability/reviews' }] },
];

test.each([false, true])('same item identity checks each destination and disabled policy=%s', async disabled => {
  const h = harness({ disabled, aliases: {
    'navigation-section-items-observability': { href: '/observability/reviews' },
  } });
  const sections = aliasSections.map(section => ({ ...section,
    items: section.items.map(item => ({ ...item, disabled_reason: disabled ? 'restricted' : null })),
  }));
  await h.assertNavigationMatches({ page: h.page, basePath: '', sections });
  expect(h.calls).toEqual([
    'navigation-section-items-workflows', 'navigation-item-review',
    'navigation-section-items-observability', 'navigation-item-review',
  ]);
});

test('second alias rejects its own wrong destination', async () => {
  const h = harness();
  await expect(h.assertNavigationMatches({ page: h.page, basePath: '', sections: aliasSections })).rejects.toThrow();
});

test.each([
  { disabled: false, title: 'Policy restriction' },
  { disabled: true, title: '' },
])('second alias preserves disabled policy and accessible reason: %j', async alias => {
  const h = harness({ disabled: true, aliases: { 'navigation-section-items-observability': alias } });
  const sections = aliasSections.map(section => ({ ...section,
    items: section.items.map(item => ({ ...item, disabled_reason: 'restricted' })),
  }));
  await expect(h.assertNavigationMatches({ page: h.page, basePath: '', sections })).rejects.toThrow();
});
