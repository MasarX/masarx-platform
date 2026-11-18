import * as fs from "node:fs";
import * as path from "node:path";

describe("actual FieldOps task card identity rendering", () => {
  const ts = require("typescript");
  const vm = require("node:vm");
  const React = require("react");
  const native = require("react-native-web");
  const render = require("react-dom/server").renderToStaticMarkup;
  const source = ts.createSourceFile("App.tsx", fs.readFileSync(path.resolve("apps/fieldops/App.tsx"), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (source.parseDiagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(source.parseDiagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (name: string) => name, getNewLine: () => "\n" }));
  const functions = new Map<string, any>();
  function collect(node: any) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.getText(source), node);
    ts.forEachChild(node, collect);
  }
  collect(source);
  const branches: any[] = [];
  function taskBranch(node: any) {
    if (ts.isIfStatement(node) && node.expression.getText(source) === 'surfaceKind === "tasks"') branches.push(node);
    ts.forEachChild(node, taskBranch);
  }
  taskBranch(functions.get("ResourceListView"));
  if (branches.length !== 1) throw new Error("Expected exactly one actual task card render branch");
  const helpers = ["asRecord", "pickFirstTextValue", "pickResourceId", "formatOperationalTitle",
    "coerceValueText", "normalizeTaskStateToken", "formatKeyLabel", "formatOperationalStatusChip"];
  const code = helpers.map(name => {
    const declaration = functions.get(name);
    if (!declaration) throw new Error("Missing actual App helper " + name);
    return declaration.getText(source);
  }).join("\n") + "\nmodule.exports = (item, list, openItem) => { const surfaceKind = 'tasks'; "
    + branches[0].getText(source) + " };";
  const compiled = ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const exported = { exports: undefined as any };
  vm.runInNewContext(compiled, { React, ...native, styles: {},
    extractTaskCardSnapshot: require("../../../apps/fieldops/src/mobile-shell-surface-helpers").extractTaskCardSnapshot,
    module: exported });
  const card = exported.exports;
  const financialMaps: any[] = [];
  function collectFinancialMap(node: any) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "composerFinancialContext.sessions.map") financialMaps.push(node.arguments[0]);
    ts.forEachChild(node, collectFinancialMap);
  }
  collectFinancialMap(source);
  if (financialMaps.length !== 1) throw new Error("Expected exactly one actual financial session map");
  const financialCode = "module.exports = (strings, styles, composerFinancialSession, composerSubmitting, setComposerFinancialSession) => ("
    + financialMaps[0].getText(source) + ");";
  const financialModule = { exports: undefined as any };
  vm.runInNewContext(ts.transpileModule(financialCode, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText, { React, ...native, module: financialModule });
  const financialCases = ["Session", "الجلسة"].flatMap(label =>
    ["", "session-a", "session-b"].flatMap(selected => [false, true].map(disabled => ({ label, selected, disabled }))));
  test.each(financialCases)("actual financial radios label=$label selected=$selected disabled=$disabled", ({ label, selected, disabled }) => {
    const sessions = [{ id: "session-a", opened_at: "2026-09-08" }, { id: "session-b", opened_at: "2026-09-08" }];
    const choose = jest.fn();
    const sessionElement = financialModule.exports({ financialTasks: { session: label } },
      { chip: {}, navItemSelected: {}, chipText: {} }, selected, disabled, choose);
    const elements = sessions.map(sessionElement);
    // Real RNweb hosts share React with the renderer; no accessibility-state mock translation.
    const html = render(React.createElement(React.Fragment, null, ...elements));
    const inputs = html.match(/<input\b[^>]*>/g) || [];
    expect(inputs).toHaveLength(2);
    expect(html.match(/<label\b/g) || []).toHaveLength(2);
    inputs.forEach((input: string, index: number) => {
      expect(input).toContain('type="radio"');
      expect(input).toContain('name="financial-task-session"');
      expect(input).toContain('value="' + sessions[index].id + '"');
      expect(/\bchecked=""/.test(input)).toBe(selected === sessions[index].id);
      expect(/\bdisabled=""/.test(input)).toBe(disabled);
    });
    expect(html).not.toContain("aria-selected=");
    expect(html).toContain(label);
    if (!disabled) {
      const input = elements[0].props.children.props.children[0];
      input.props.onChange();
      input.props.onChange();
      expect(choose.mock.calls).toEqual([["session-a"], ["session-a"]]);
    }
    // SSR establishes actual DOM semantics, not keyboard execution or native-device proof.
  });
  test.each(['en', 'ar'] as const)('actual Tasks sync button retains localized name and pending semantics: %s', locale => {
    const controls: any[] = [];
    function collectSync(node: any) {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'Pressable' &&
          node.openingElement.attributes.properties.some((attribute: any) =>
            attribute.name?.getText(source) === 'onPress' && attribute.initializer?.getText(source) === '{() => syncMutation.mutate()}') &&
          node.getText(source).includes('strings.shell.syncNow')) controls.push(node);
      ts.forEachChild(node, collectSync);
    }
    collectSync(source);
    expect(controls).toHaveLength(1);
    const strings = require('../../../apps/fieldops/src/i18n').getFieldOpsStrings(locale);
    for (const pending of [false, true]) {
      const mutate = jest.fn();
      const exported = { exports: undefined as any };
      vm.runInNewContext(ts.transpileModule('module.exports = (' + controls[0].getText(source) + ');', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
      }).outputText, { React, ...native, styles: {}, strings, syncMutation: { isPending: pending, mutate }, module: exported });
      const element = exported.exports;
      const html = render(element);
      expect(html).toContain('role="button"');
      expect(html).toContain('aria-label="' + (pending ? strings.shell.syncing : strings.shell.syncNow) + '"');
      expect(html.includes('aria-disabled="true"')).toBe(pending);
      expect(html.includes('aria-busy="true"')).toBe(pending);
      expect(element.props.disabled).toBe(pending);
      if (!pending) { element.props.onPress(); expect(mutate).toHaveBeenCalledTimes(1); }
    }
  });

  test.each(['Complete task', 'إكمال المهمة'])('actual shared action role and disabled/busy semantics: %s', label => {
    const actions: any[] = [];
    function findAction(node: any) {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'Pressable' &&
          node.openingElement.attributes.properties.some((attribute: any) => attribute.name?.getText(source) === 'testID' &&
            attribute.initializer?.getText(source) === '{`mobile-action-${command.key}`}')) actions.push(node);
      ts.forEachChild(node, findAction);
    }
    findAction(source); expect(actions).toHaveLength(1);
    for (const drivingModeLocked of [false, true]) for (const actionLocked of [false, true]) {
      const module = { exports: undefined as any };
      const press = jest.fn();
      vm.runInNewContext(ts.transpileModule('module.exports = (' + actions[0].getText(source) + ');', {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
      }).outputText, { React, ...native, styles: {}, command: { key: 'tasks.complete' }, commandLabel: label, needsInput: true,
        drivingModeLocked, actionLocked, handleActionPress: press, module });
      const html = render(module.exports);
      expect(html).toContain('role="button"');
      expect(html).toContain(label + '...');
      expect(html.includes('aria-disabled="true"')).toBe(drivingModeLocked || actionLocked);
      expect(html.includes('aria-busy="true"')).toBe(actionLocked);
      expect(module.exports.props.disabled).toBe(drivingModeLocked || actionLocked);
      if (!drivingModeLocked && !actionLocked) { module.exports.props.onPress(); expect(press).toHaveBeenCalledTimes(1); }
    }
  });

  test("same display title retains distinct canonical IDs and exact press targets", () => {
    const items = [
      { id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", title: "Task" },
      { id: "22222222-2222-4222-8222-222222222222", title: "Task" },
    ];
    const selected = jest.fn();
    const elements = items.map(item => card(item, { keys: ["id", "title"] }, selected));
    for (let index = 0; index < items.length; index += 1) {
      expect(elements[index].props.testID).toBe("mobile-task-card-" + items[index].id);
      const html = render(elements[index]);
      expect(html).toContain('data-testid="mobile-task-card-' + items[index].id + '"');
      expect(html).toContain("Task");
      elements[index].props.onPress();
      expect(selected.mock.calls[index][0]).toBe(items[index]);
    }
    expect(selected).toHaveBeenCalledTimes(2);
  });
  test.each([undefined, "  "])("missing canonical ID %s cannot turn the title into identity", id => {
    const item = { id, title: "Task" };
    const selected = jest.fn();
    const element = card(item, { keys: ["id", "title"] }, selected);
    expect(element.props.testID).toBeUndefined();
    expect(render(element)).not.toContain("mobile-task-card-");
    element.props.onPress();
    expect(selected).toHaveBeenCalledWith(item);
  });
});

describe("FieldOps display integration contract", () => {
  const source = fs.readFileSync(path.resolve("apps/fieldops/App.tsx"), "utf8");
  test("wires operational scan copy to the selected catalog and state", () => {
    const start = source.indexOf("function ScanScreen(");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\nfunction ", start + 1);
    const scan = source.slice(start, end < 0 ? source.length : end).replace(/\r/g, "");
    for (const key of [
      "cameraUnavailable", "permissionRequired", "permissionDenied", "permissionPrompt",
      "openSettings", "grantPermission", "lastQueued", "queuedOnline", "queuedOffline", "context",
    ]) expect(scan).toContain("strings.scan." + key);
    expect(scan).toMatch(/effectiveScanInputMode !== "camera"\s*\? strings\.scan\.cameraUnavailable/);
    expect(scan).toMatch(/permission\?\.canAskAgain === false\s*\? strings\.scan\.permissionDenied\s*: strings\.scan\.permissionPrompt/);
    expect(scan).toContain("permission?.canAskAgain === false ? strings.scan.openSettings : strings.scan.grantPermission");
    expect(scan).toContain("online ? strings.scan.queuedOnline : strings.scan.queuedOffline");
  });

  test("resolves one row-driven display policy and constrains persisted choices", () => {
    expect(source).toContain("normalizeMobileDisplayPolicy(asRecord(devicePolicyQuery.data).value ?? null)");
    expect(source).toContain("resolveEffectiveLocale({ storedValue: localeModeQuery.data, policy: displayPolicy })");
    expect(source).toContain("resolveEffectiveTheme({ storedValue: themeModeQuery.data, policy: displayPolicy })");
  });

  test("uses live system theme, typed copy, and context-scoped styles", () => {
    expect(source).toContain("const systemColorScheme = useColorScheme()");
    expect(source).toContain("const appliedTheme = resolveAppliedFieldOpsTheme(selectedThemeMode, systemColorScheme)");
    expect(source).toMatch(/const themeTokens = React\.useMemo\(\s*\(\) => getFieldOpsThemeTokens\(appliedTheme, Platform\.OS === "web" \? "web" : "native"\),\s*\[appliedTheme\]\s*\)/);
    expect(source).toMatch(/const styles = React\.useMemo\(\(\) => createFieldOpsStyles\(themeTokens\), \[themeTokens\]\)/);
    expect(source).toContain("getFieldOpsStrings(selectedLocaleMode)");
    expect(source).toContain("<FieldOpsStylesContext.Provider value={styles}>");
    expect(source).not.toContain("const FIELDOPS_TOKENS =");
  });

  test("applies RTL without a restart-only native force", () => {
    expect(source).toContain("doc.documentElement.dir = selectedDirectionMode");
    expect(source).not.toContain("I18nManager.forceRTL");
  });

  test.each([
    "OutboxScreen", "ScanScreen", "LocationScreen", "DiagnosticsScreen",
    "RouteSurfaceDetailExtensions", "SettlementSurfaceDetailExtensions", "ResourceListView",
  ])("passes the selected catalog to %s without another locale resolver", (name) => {
    const call = source.match(new RegExp("<" + name + "\\b[\\s\\S]*?/>"));
    expect(call).not.toBeNull();
    expect(call?.[0]).toMatch(/\bstrings=\{strings\}/);
    const start = source.indexOf("function " + name + "(");
    const end = source.indexOf("\nfunction ", start + 1);
    const component = source.slice(start, end < 0 ? source.length : end);
    expect(component).toContain("strings: FieldOpsStrings");
    expect(component).not.toContain("getFieldOpsStrings(");
  });

  test("uses all six selected formatters at their current display seams", () => {
    for (const expression of [
      "strings.tasks.itemsCount(list.total ?? list.items.length)",
      "strings.route.subtitle(routeSummary?.totalStops ?? 0)",
      "strings.outbox.pending(outboxCount)",
      "strings.detail.reference(stop.reference)",
      "strings.detail.recipient(customerName || strings.detail.noRecipient)",
      "strings.detail.accuracy(Math.round(coordinates.accuracyM))",
    ]) expect(source).toContain(expression);
  });

  test("keeps route closeout distinct from driver-shift settlement identity and window", () => {
    const route = source.slice(
      source.indexOf("function RouteSurfaceDetailExtensions("),
      source.indexOf("function SettlementSurfaceDetailExtensions(")
    );
    const settlement = source.slice(
      source.indexOf("function SettlementSurfaceDetailExtensions("),
      source.indexOf("function ResourceListView(")
    );

    for (const key of ["closeoutTitle", "closeoutRoute", "closeoutScope", "settlementBoundaryTitle", "settlementBoundary"]) {
      expect(route).toContain(`strings.route.${key}`);
    }
    expect(route).not.toContain("Route parcel closeout");
    expect(route).not.toContain("No settlement is inferred for this route.");
    expect(route).not.toContain("extractSettlementSnapshot");
    expect(settlement).toContain("extractSettlementSnapshot(detail, fallbackId)");
    expect(settlement).toContain("settlement.windowStartAt ?? \"-\"");
    expect(settlement).toContain("settlement.windowEndAt ?? \"-\"");
  });

  test("keeps new wallet and return UI localized and persists accepted requests before summary refresh", () => {
    expect(source).toContain("strings={strings.wallet}");
    expect(source).toContain("strings={strings.returnActions}");
    expect(source).toContain("strings.scan.returnPreserveFailed");
    expect(source).toContain("strings.actionFeedback.incidentUnavailable");
    const wallet = source.slice(source.indexOf("function WalletCard("), source.indexOf("function MoreScreen("));
    const receipt = wallet.indexOf("const receipt = readWalletReceipt(data);");
    const serialized = wallet.indexOf("await writeCompletionScopedValue(cacheStore, epoch, actorId, scope,", receipt);
    const saved = wallet.indexOf("() => cacheStore.set(requestKey, { ...request, taskId: receipt.taskId })", serialized);
    const refresh = wallet.indexOf("const refreshed = await client.schema(\"api\").rpc(", receipt);
    expect(receipt).toBeGreaterThan(0);
    expect(saved).toBeGreaterThan(receipt);
    expect(serialized).toBeGreaterThan(receipt);
    expect(refresh).toBeGreaterThan(saved);
    expect(wallet).toContain("setFeedback(strings.summaryWarning)");
  });

  test("keeps translated copy in the existing protected action and banner seams", () => {
    expect(source).toContain("title: strings.confirm.signOutTitle");
    expect(source).toContain("danger: true");
    expect(source).toContain("strings.settlements.countQueuedTitle, strings.settlements.countQueuedMessage");
    expect(source).toContain('connectivityStatus === "offline" ? strings.shell.offlineMode : strings.shell.degradedTitle');
    expect(source).toContain("Alert.alert(strings.alerts.drivingLockedTitle, strings.alerts.drivingLockedMessage)");
    expect(source).toContain("[drivingSafetyState, navBlockedWhileDriving, navigationItems, selectedId, strings.alerts.drivingLockedTitle]");
    expect(source).toContain("{strings.detail[channel]}");
  });
});
