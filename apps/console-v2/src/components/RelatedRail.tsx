// RelatedRail.tsx — universal tabbed inline panel for drawers, now backed
// by Radix UI Tabs primitives so the tab strip gets:
//
//   • roving tabindex (only the active tab is in the tab order)
//   • Left/Right arrow navigation between tabs, Home/End jumps
//   • role="tablist" / "tab" / "tabpanel" + aria-selected/aria-controls
//   • aria-orientation = horizontal
//
// Mirrors demo `relatedRail({ summary, tabs, defaultTab })`:
// each tab declares an async `render()` whose result is mounted into the
// rail body when the tab becomes active. Tabs render lazily and switching
// re-runs the render (no per-tab cache, matching the legacy demo so data
// stays fresh on each visit).
//
// Visual contract preserved: `.rail`, `.rail-tabs`, `.rail-tab`,
// `.rail-tab__count`, `.rail-body`, plus `.is-active` on the active tab
// trigger. CSS in src/styles/components.css owns all visual rules.
import {
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { StateView } from './StateView';
import { useI18n } from '../lib/i18n';

export interface RelatedTab {
  id: string;
  label: ReactNode;
  count?: number;
  /** Render the tab body. May return a ReactNode synchronously or via Promise. */
  render: () => ReactNode | Promise<ReactNode>;
}

export interface RelatedRailProps {
  summary?: ReactNode;
  tabs: RelatedTab[];
  defaultTab?: string;
  className?: string;
}

type TabState =
  | { status: 'loading' }
  | { status: 'ready'; node: ReactNode }
  | { status: 'error'; message: string };

export function RelatedRail({ summary, tabs, defaultTab, className }: RelatedRailProps) {
  const { t } = useI18n();
  const [active, setActive] = useState<string>(defaultTab ?? tabs[0]?.id ?? '');
  const [bodyState, setBodyState] = useState<TabState>({ status: 'loading' });

  // Reset active when the tabs list changes underneath us (e.g. drawer swap).
  useEffect(() => {
    if (!tabs.find((tab) => tab.id === active)) {
      setActive(defaultTab ?? tabs[0]?.id ?? '');
    }
  }, [tabs, defaultTab, active]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tab = tabs.find((tt) => tt.id === active);
      if (!tab) return;
      setBodyState({ status: 'loading' });
      try {
        const node = await tab.render();
        if (!cancelled) setBodyState({ status: 'ready', node });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err ?? '');
        setBodyState({ status: 'error', message });
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally re-run on (active, tabs) — tabs are passed by ref and
    // each call wants a fresh render() closure (no per-tab cache).
  }, [active, tabs]);

  const wrapClasses = ['rail', className].filter(Boolean).join(' ');

  return (
    <div className={wrapClasses}>
      {summary ?? null}
      <Tabs.Root
        value={active}
        onValueChange={setActive}
        // We render a single body slot below (one panel for the active tab),
        // so disable Tabs's automatic activation-follows-focus to keep
        // the demo's "click to switch" semantics. The roving focus ring
        // still works.
        activationMode="manual"
      >
        <Tabs.List className="rail-tabs" loop>
          {tabs.map((tab) => {
            const tabClasses = ['rail-tab', tab.id === active ? 'is-active' : '']
              .filter(Boolean)
              .join(' ');
            return (
              <Tabs.Trigger
                key={tab.id}
                value={tab.id}
                className={tabClasses}
              >
                <span>{tab.label}</span>
                {tab.count != null ? (
                  <span className="rail-tab__count mono">{String(tab.count)}</span>
                ) : null}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>
        {/* Render a single Tabs.Content slot bound to the active tab id, so
            Radix manages the role="tabpanel" + aria-labelledby wiring while
            our async-render pipeline owns what goes inside. */}
        {active ? (
          <Tabs.Content value={active} className="rail-body" forceMount>
            {bodyState.status === 'loading' ? (
              <div className="state__hint" style={{ padding: '14px' }}>
                {t('common.loading', 'Loading…')}
              </div>
            ) : null}
            {bodyState.status === 'error' ? (
              <StateView kind="error" hint={bodyState.message} />
            ) : null}
            {bodyState.status === 'ready' ? bodyState.node ?? null : null}
          </Tabs.Content>
        ) : (
          <div className="rail-body" />
        )}
      </Tabs.Root>
    </div>
  );
}
