// _shared.test.tsx — pure-helper unit tests for the J insights shared module.
// These do not require a router — they exercise only the pure helpers
// (clampByRange, clampByScope, buildCurlGet, buildCurlRpc, isRangeKey,
// isScopeKey) plus a minimal smoke render for <RangeChips> / <ScopeChips> /
// <CurlBlock>.

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import {
  RANGE_OPTIONS,
  SCOPE_OPTIONS,
  buildCurlGet,
  buildCurlRpc,
  clampByRange,
  clampByScope,
  isRangeKey,
  isScopeKey,
  rangeMs,
  type RangeKey,
  type ScopeKey,
} from './_shared';
import { RangeChips, ScopeChips, CurlBlock } from './_components';

describe('_shared · pure helpers', () => {
  it('isRangeKey accepts all canonical keys and rejects others', () => {
    for (const opt of RANGE_OPTIONS) {
      expect(isRangeKey(opt.key)).toBe(true);
    }
    expect(isRangeKey('30m')).toBe(false);
    expect(isRangeKey(undefined)).toBe(false);
    expect(isRangeKey(123)).toBe(false);
    expect(isRangeKey(null)).toBe(false);
  });

  it('isScopeKey accepts all canonical scope ladder values', () => {
    for (const opt of SCOPE_OPTIONS) {
      expect(isScopeKey(opt.key)).toBe(true);
    }
    expect(isScopeKey('region')).toBe(false);
    expect(isScopeKey('')).toBe(false);
  });

  it('rangeMs returns the correct millisecond budget per key', () => {
    expect(rangeMs('5m')).toBe(5 * 60 * 1000);
    expect(rangeMs('1h')).toBe(60 * 60 * 1000);
    expect(rangeMs('24h')).toBe(24 * 60 * 60 * 1000);
    expect(rangeMs('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(rangeMs('all')).toBeNull();
    expect(rangeMs(undefined)).toBeNull();
  });

  it('clampByRange filters rows whose `at` field falls outside the window', () => {
    const now = Date.now();
    const rows = [
      { id: 'r1', at: new Date(now - 1 * 60 * 1000).toISOString() }, // 1 min ago
      { id: 'r2', at: new Date(now - 30 * 60 * 1000).toISOString() }, // 30 min ago
      { id: 'r3', at: new Date(now - 25 * 60 * 60 * 1000).toISOString() }, // 25 h ago
    ];
    expect(clampByRange(rows, 'at', '5m').map((r) => r.id)).toEqual(['r1']);
    expect(clampByRange(rows, 'at', '1h').map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(clampByRange(rows, 'at', '24h').map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(clampByRange(rows, 'at', '7d').map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(clampByRange(rows, 'at', 'all').map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('clampByRange leaves rows missing the timestamp field intact', () => {
    const rows = [{ id: 'r1' }, { id: 'r2', at: new Date(0).toISOString() }];
    // r1 has no `at`, r2 is way out of any window
    const out = clampByRange(rows, 'at', '5m');
    expect(out.map((r) => r.id)).toEqual(['r1']);
  });

  it('clampByRange tolerates an unparseable timestamp by passing the row through', () => {
    const rows = [{ id: 'r1', at: 'not-a-date' }];
    expect(clampByRange(rows, 'at', '5m')).toEqual(rows);
  });

  it('clampByScope passes through when scope is "all" or unset', () => {
    const rows = [
      { id: 'r1', resolved_from: 'tenant' },
      { id: 'r2', resolved_from: 'client' },
    ];
    expect(clampByScope(rows, 'resolved_from', 'all').length).toBe(2);
    expect(clampByScope(rows, 'resolved_from', undefined).length).toBe(2);
  });

  it('clampByScope filters by exact scope match', () => {
    const rows = [
      { id: 'r1', resolved_from: 'tenant' },
      { id: 'r2', resolved_from: 'client' },
      { id: 'r3', resolved_from: 'tenant' },
    ];
    expect(clampByScope(rows, 'resolved_from', 'tenant').map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(clampByScope(rows, 'resolved_from', 'client').map((r) => r.id)).toEqual(['r2']);
    expect(clampByScope(rows, 'resolved_from', 'global').map((r) => r.id)).toEqual([]);
  });

  it('buildCurlGet emits a REST-shaped command with placeholder env vars only (no secrets)', () => {
    const curl = buildCurlGet({ table: 'decision_log', predicate: 'id=eq.dlog_5821' });
    expect(curl).toContain('$SUPABASE_URL/rest/v1/decision_log?id=eq.dlog_5821');
    expect(curl).toContain('Authorization: Bearer $SUPABASE_KEY');
    expect(curl).toContain('apikey: $SUPABASE_KEY');
    // The select default is *. encodeURIComponent leaves '*' unchanged per spec,
    // so the literal asterisk appears in the URL.
    expect(curl).toContain('select=*');
    // Sanity: no real keys / urls embedded
    expect(curl).not.toMatch(/eyJ/); // no JWT
    expect(curl).not.toMatch(/https?:\/\/[a-z0-9-]+\.supabase\.co/);
  });

  it('buildCurlGet honors a custom select clause', () => {
    const curl = buildCurlGet({
      table: 'ui_event_log',
      predicate: 'id=eq.uev_9001',
      select: 'id,event_type,occurred_at',
    });
    expect(curl).toContain('select=id%2Cevent_type%2Coccurred_at');
  });

  it('buildCurlRpc emits a POST against /rpc/<name> with body JSON', () => {
    const curl = buildCurlRpc('ui_get_trace_v1', { p_correlation_id: 'cor_9821' });
    expect(curl).toContain('-X POST');
    expect(curl).toContain('/rest/v1/rpc/ui_get_trace_v1');
    // The JSON body is stringified into a shell argument, so the inner quotes
    // are escaped (\"). The field name and value still appear verbatim.
    expect(curl).toContain('p_correlation_id');
    expect(curl).toContain('cor_9821');
  });
});

describe('_shared · <RangeChips>', () => {
  it('renders a chip per option and reflects the active value via aria-pressed', () => {
    const onChange = (next: RangeKey) => void next;
    render(<RangeChips value="1h" onChange={onChange} />);
    for (const opt of RANGE_OPTIONS) {
      const btn = screen.getByRole('button', { name: opt.label });
      expect(btn).toBeTruthy();
      expect(btn.getAttribute('aria-pressed')).toBe(opt.key === '1h' ? 'true' : 'false');
    }
  });

  it('invokes onChange when a chip is clicked', () => {
    const calls: RangeKey[] = [];
    render(<RangeChips value="all" onChange={(next) => calls.push(next)} />);
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    expect(calls).toEqual(['24h']);
  });
});

describe('_shared · <ScopeChips>', () => {
  // W54-D — `<ScopeChips>` now subscribes to `scope_type_registry` via
  // `useScopeOptions()`, which calls `useResourceList`. The component must
  // be rendered inside a QueryClientProvider; `renderWithProviders` wraps
  // it with the canonical test query client.
  it('renders the canonical override-ladder scope keys', () => {
    const onChange = (next: ScopeKey) => void next;
    renderWithProviders(<ScopeChips value="all" onChange={onChange} />);
    for (const opt of SCOPE_OPTIONS) {
      const btn = screen.getByRole('button', { name: opt.label });
      expect(btn).toBeTruthy();
      // chip should carry the scope key as a data-attr for visual regression / e2e
      expect(btn.getAttribute('data-scope')).toBe(opt.key);
    }
  });

  it('marks the active scope', () => {
    const onChange = (next: ScopeKey) => void next;
    renderWithProviders(<ScopeChips value="client" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Client' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Tenant' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('_shared · <CurlBlock>', () => {
  it('renders the value verbatim and labels the copy button', () => {
    render(<CurlBlock value={'curl https://example.test'} caption="Lookup command" />);
    expect(screen.getByText(/Lookup command/)).toBeTruthy();
    expect(screen.getByLabelText('curl command')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy curl' })).toBeTruthy();
    expect(screen.getByText('curl https://example.test')).toBeTruthy();
  });

  it('writes to clipboard when Copy is clicked', () => {
    let captured: string | null = null;
    const writeText = (s: string) => {
      captured = s;
      return Promise.resolve();
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<CurlBlock value={'curl https://example.test'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy curl' }));
    expect(captured).toBe('curl https://example.test');
  });
});
