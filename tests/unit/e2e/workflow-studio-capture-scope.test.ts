/** @jest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

describe.each(['console', 'portal'])('%s overlap capture scope', (app) => {
  const source = readFileSync(
    resolve(__dirname, '../../e2e', `${app}-workflow-studio-capture.spec.ts`),
    'utf8'
  );
  const cssLocator = source.match(/mainContent\.locator\(\s*'([^'\n]*workflow-overlaps-ready[^'\n]*)'\s*\)/);
  const testIdLocator = source.match(/page\.locator\("#main-content"\)\.getByTestId\("([^"\n]*workflow-overlaps-ready[^"\n]*)"\)/);
  const locatorExpression = cssLocator?.[0] ?? testIdLocator?.[0];
  if (!locatorExpression) throw new Error(`Missing scoped ${app} overlap locator`);
  if (cssLocator) expect(source).toContain('const mainContent = page.locator("#main-content");');
  const selector = cssLocator
    ? cssLocator[1].split(',').map((part) => `#main-content ${part.trim()}`).join(', ')
    : `#main-content [data-testid="${testIdLocator![1]}"]`;

  afterEach(() => { document.body.innerHTML = ''; });

  test.each(['ready', 'error', 'auth'])('handles the active %s state without accepting an outside streamed copy', (state) => {
    const marker = state === 'auth' ? `${app}-auth-required` : `${app}-workflow-overlaps-${state}`;
    document.body.innerHTML = `<main id="main-content"><div data-testid="${marker}"></div></main><div hidden><div data-testid="${marker}"></div></div>`;
    const matches = document.querySelectorAll(selector);
    expect(matches).toHaveLength(app === 'console' || state === 'ready' ? 1 : 0);
    for (const match of matches) expect(match.closest('#main-content')).not.toBeNull();
  });

  test('keeps two active markers ambiguous instead of selecting the first', () => {
    const marker = `${app}-workflow-overlaps-ready`;
    document.body.innerHTML = `<main id="main-content"><div data-testid="${marker}"></div><div data-testid="${marker}"></div></main>`;
    expect(document.querySelectorAll(selector)).toHaveLength(2);
    expect(source.slice(source.indexOf(locatorExpression) + locatorExpression.length)).toMatch(/^\s*\)\.toBeVisible\(\)/);
  });

  test('does not accept loading or an outside-only terminal state', () => {
    document.body.innerHTML = `<main id="main-content"><div data-testid="${app}-workflow-overlaps-loading"></div></main><div data-testid="${app}-workflow-overlaps-ready"></div>`;
    expect(document.querySelectorAll(selector)).toHaveLength(0);
  });
});

describe('Console Studio capture budgets', () => {
  const source = readFileSync(
    resolve(__dirname, '../../e2e/console-workflow-studio-capture.spec.ts'), 'utf8',
  );
  const parsed = ts.createSourceFile('capture.ts', source, ts.ScriptTarget.Latest, true);
  const cases = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'test'
      && ts.isStringLiteral(node.arguments[0]) && ts.isArrowFunction(node.arguments[1])) {
      cases.set(node.arguments[0].text, node.arguments[1].body.getText(parsed));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);

  test('separates page/trigger setup from flow controls without increasing case timeouts', () => {
    expect([...cases.keys()]).toEqual([
      'captures workflow templates and studio pages',
      'captures workflow flow and builder controls',
    ]);
    for (const body of cases.values()) {
      expect(body.match(/test\.setTimeout\(300_000\)/g)).toHaveLength(1);
      expect(body).toContain('openWorkflowConsole(page, evidencePath)');
      expect(body).toContain('openWorkflowTemplateStudioWithDisconnect');
    }
    const pages = cases.get('captures workflow templates and studio pages')!;
    expect(pages).toContain('console-workflow-template-create.png');
    expect(pages).toContain('console-workflow-template-studio-triggers.png');
    expect(pages).toContain('Wait for workflow test-run navigation');
    expect(pages).not.toContain('flowStepCard.click');
  });

  test('retains flow interaction, keyboard, inspector and builder assertions in the second case', () => {
    const controls = cases.get('captures workflow flow and builder controls')!;
    for (const contract of [
      'flowStepCard.click({ timeout: 20_000 })',
      'expect(flowStepEditorDrawer).toBeVisible({ timeout: 20_000 })',
      'focusWithTab(page, flowCanvasScroll)',
      'expect(connectTo).toBeDisabled({ timeout: 20_000 })',
      'console-workflow-template-studio-steps-flow-run-inspector-logs-advanced.png',
      'console-workflow-template-studio-step-editor-metadata-invalid.png',
      'expect(schemaLoading).toBeHidden({ timeout: 60_000 })',
      'console-workflow-template-studio-add-step-modal.png',
    ]) expect(controls).toContain(contract);
  });
});
