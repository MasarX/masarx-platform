const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../../e2e/utils/table-actions.ts'), 'utf8');
const body = source.slice(source.indexOf('export async function ensureBulkActionVisible'), source.indexOf('export async function openFirstSingleLineInlineEditor'));
const compiled = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function harness({ inline = false, open = false, present = true, triggerPresent = true, disabled = false, escapeClosesMenu = true } = {}) {
  const prefix = 'console-resource-table-bulk-actions';
  const actionKey = 'shipments.delete';
  let rendered = open;
  const calls = [];
  const action = {
    disabled,
    first() { return this; },
    count: async () => Number(present && rendered),
    isVisible: async () => present && rendered,
  };
  const inlineAction = { ...action, count: async () => Number(inline), isVisible: async () => inline };
  const trigger = {
    count: async () => Number(triggerPresent),
    getAttribute: async name => {
      if (name === 'data-state') return open ? 'open' : 'closed';
      if (name === 'aria-controls') return open ? 'owned-menu' : null;
      throw new Error('Unexpected attribute: ' + name);
    },
    click: jest.fn(async () => { calls.push('click'); open = !open; }),
  };
  const menu = { isVisible: async () => open };
  const container = {
    count: async () => 1,
    locator: selector => {
      expect(selector).toBe(`[data-action-key="${actionKey}"]`);
      return inlineAction;
    },
    getByTestId: id => {
      expect(id).toBe(`${prefix}-menu`);
      return trigger;
    },
  };
  const page = {
    keyboard: {
      press: jest.fn(async key => {
        expect(key).toBe('Escape');
        calls.push('escape');
        if (escapeClosesMenu) { open = false; rendered = false; }
      }),
    },
    locator: selector => {
      if (selector === `[data-testid="${prefix}"]`) return container;
      expect(selector).toBe('[id="owned-menu"][role="menu"]');
      return menu;
    },
    getByTestId: id => {
      expect(id).toBe(`${prefix}-menu-action-${actionKey}`);
      return action;
    },
  };
  const assertLocator = locator => ({
    toBeVisible: async () => {
      calls.push(locator === menu ? 'menu-ready' : 'action-visible');
      expect(await locator.isVisible()).toBe(true);
      if (locator === menu) rendered = true;
    },
    toHaveAttribute: async (name, expected) => {
      const value = await locator.getAttribute(name);
      expect(typeof expected === 'string' ? value === expected : expected.test(value ?? '')).toBe(true);
    },
  });
  const exports = {};
  new Function('exports', 'expect', 'selectFirstTableRow', compiled)(exports, assertLocator,
    () => { throw new Error('Existing selection must be preserved'); });
  return {
    run: () => exports.ensureBulkActionVisible({ page, actionKey, testIdPrefix: 'console-resource-table' }),
    trigger, action, inlineAction, calls, keyboard: page.keyboard,
  };
}

test('returns the scoped inline action without opening the menu', async () => {
  const h = harness({ inline: true });
  expect(await h.run()).toBe(h.inlineAction);
  expect(h.trigger.click).not.toHaveBeenCalled();
  expect(h.keyboard.press).not.toHaveBeenCalled();
});

test('dismisses its open owned menu before returning an inline action', async () => {
  const h = harness({ inline: true, open: true });
  expect(await h.run()).toBe(h.inlineAction);
  expect(h.keyboard.press).toHaveBeenCalledWith('Escape');
  expect(h.trigger.click).not.toHaveBeenCalled();
  expect(h.calls).toEqual(['escape', 'action-visible']);
});

test('does not return an inline action when owned menu dismissal fails', async () => {
  const h = harness({ inline: true, open: true, escapeClosesMenu: false });
  await expect(h.run()).rejects.toThrow();
  expect(h.keyboard.press).toHaveBeenCalledTimes(1);
  expect(h.calls).not.toContain('action-visible');
});

test('an inline action without an owned menu does not dismiss unrelated UI', async () => {
  const h = harness({ inline: true, triggerPresent: false });
  expect(await h.run()).toBe(h.inlineAction);
  expect(h.keyboard.press).not.toHaveBeenCalled();
});

test('dismissal preserves a disabled inline action for policy assertions', async () => {
  const h = harness({ inline: true, open: true, disabled: true });
  expect(await h.run()).toBe(h.inlineAction);
  expect(h.inlineAction.disabled).toBe(true);
  expect(h.keyboard.press).toHaveBeenCalledTimes(1);
});

test('reuses an already visible owned portal action without toggling', async () => {
  const h = harness({ open: true });
  expect(await h.run()).toBe(h.action);
  expect(h.trigger.click).not.toHaveBeenCalled();
});

test('waits for the opened owned menu before inspecting delayed items', async () => {
  const h = harness();
  expect(await h.run()).toBe(h.action);
  expect(h.trigger.click).toHaveBeenCalledTimes(1);
  expect(h.calls).toEqual(['click', 'menu-ready', 'action-visible']);
});

test.each([false, true])('genuine absent item returns null after menu readiness, initially open=%s', async open => {
  const h = harness({ open, present: false });
  expect(await h.run()).toBeNull();
  expect(h.calls).toContain('menu-ready');
  expect(h.trigger.click).toHaveBeenCalledTimes(open ? 0 : 1);
});

test('absent menu trigger returns null without crossing into other containers', async () => {
  const h = harness({ triggerPresent: false });
  expect(await h.run()).toBeNull();
  expect(h.trigger.click).not.toHaveBeenCalled();
});

test('returns a disabled owned action untouched for caller policy assertions', async () => {
  const h = harness({ disabled: true });
  expect(await h.run()).toBe(h.action);
  expect(h.action.disabled).toBe(true);
});
