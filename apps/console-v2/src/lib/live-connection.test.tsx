// live-connection.test.tsx — #405 live refresh: state derivation, the page
// connection hook without realtime (seed/test builds), the Statusbar store,
// held rows and edit conflicts.
import { describe, it, expect } from 'vitest';
import { act, renderHook, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { LiveChip } from '@/components/LiveStatus';
import {
  deriveLiveState,
  LIVE_CONFIG,
  useEditConflict,
  useHeldRows,
  useLiveConnection,
  useLiveStatus,
  type LiveInputs,
  type LiveState,
} from './live-connection';

const base: LiveInputs = {
  online: true,
  realtime: true,
  channel: 'joined',
  failures: 0,
  lastBeatAt: 0,
  hasData: true,
  catchingUp: false,
  now: 1_000,
};

describe('deriveLiveState', () => {
  it.each<[string, Partial<LiveInputs>, LiveState]>([
    ['offline when the browser is offline', { online: false }, 'offline'],
    ['offline wins over missing data', { online: false, hasData: false }, 'offline'],
    ['syncing before the first data', { hasData: false }, 'syncing'],
    ['syncing while catching up after a reconnect', { catchingUp: true }, 'syncing'],
    ['polling when realtime is off', { realtime: false }, 'polling'],
    ['polling after maxReconnects failures', { channel: 'lost', failures: LIVE_CONFIG.maxReconnects }, 'polling'],
    ['live when the channel is joined', {}, 'live'],
    ['syncing while the channel connects', { channel: 'connecting' }, 'syncing'],
    [
      'reconnecting right after the channel is lost',
      { channel: 'lost', failures: 1, now: LIVE_CONFIG.offlineAfterMs - 1 },
      'reconnecting',
    ],
    [
      'offline once no heartbeat arrives for offlineAfterMs',
      { channel: 'lost', failures: 1, now: LIVE_CONFIG.offlineAfterMs },
      'offline',
    ],
  ])('%s', (_name, patch, expected) => {
    expect(deriveLiveState({ ...base, ...patch })).toBe(expected);
  });
});

function Harness({ dataUpdatedAt }: { dataUpdatedAt: number }) {
  const live = useLiveConnection({ topic: 'routes', enabled: true, dataUpdatedAt });
  return <LiveChip live={live} />;
}
function StatusProbe() {
  const status = useLiveStatus();
  return <span data-testid="probe">{status?.state ?? 'none'}</span>;
}

describe('useLiveConnection without realtime', () => {
  it('syncs, polls, goes offline with the browser and catches up on reconnect', () => {
    const { rerender } = renderWithProviders(
      <>
        <Harness dataUpdatedAt={0} />
        <StatusProbe />
      </>,
    );
    const chip = () => screen.getByTestId('live-chip');
    expect(chip()).toHaveAttribute('data-state', 'syncing');

    const loadedAt = Date.now();
    rerender(
      <>
        <Harness dataUpdatedAt={loadedAt} />
        <StatusProbe />
      </>,
    );
    expect(chip()).toHaveAttribute('data-state', 'polling');
    expect(screen.getByTestId('probe')).toHaveTextContent('polling');

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(chip()).toHaveAttribute('data-state', 'offline');
    expect(screen.getByTestId('probe')).toHaveTextContent('offline');

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(chip()).toHaveAttribute('data-state', 'syncing');

    rerender(
      <>
        <Harness dataUpdatedAt={loadedAt + 1} />
        <StatusProbe />
      </>,
    );
    expect(chip()).toHaveAttribute('data-state', 'polling');
  });

  it('clears the Statusbar status when the page unmounts', () => {
    const { rerender } = renderWithProviders(
      <>
        <Harness dataUpdatedAt={Date.now()} />
        <StatusProbe />
      </>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('polling');
    rerender(<StatusProbe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('none');
  });
});

type Row = { id: string; v: number };
const keyOf = (r: Row) => r.id;

describe('useHeldRows', () => {
  it('keeps on-screen order, updates rows in place and holds new rows until show()', () => {
    const { result, rerender } = renderHook(({ rows }: { rows: Row[] }) => useHeldRows(rows, keyOf), {
      initialProps: {
        rows: [
          { id: 'a', v: 1 },
          { id: 'b', v: 1 },
        ],
      },
    });
    expect(result.current.visible.map(keyOf)).toEqual(['a', 'b']);
    expect(result.current.newCount).toBe(0);

    rerender({
      rows: [
        { id: 'c', v: 1 },
        { id: 'b', v: 1 },
        { id: 'a', v: 2 },
      ],
    });
    expect(result.current.visible).toEqual([
      { id: 'a', v: 2 },
      { id: 'b', v: 1 },
    ]);
    expect(result.current.newCount).toBe(1);
    expect([...result.current.updated]).toEqual(['a']);

    act(() => result.current.show());
    expect(result.current.visible.map(keyOf)).toEqual(['c', 'b', 'a']);
    expect(result.current.newCount).toBe(0);
    expect(result.current.updated.size).toBe(0);
  });

  it('drops removed rows and fills an empty list without a click', () => {
    const { result, rerender } = renderHook(({ rows }: { rows: Row[] }) => useHeldRows(rows, keyOf), {
      initialProps: { rows: [] as Row[] },
    });
    rerender({
      rows: [
        { id: 'a', v: 1 },
        { id: 'b', v: 1 },
      ],
    });
    expect(result.current.visible.map(keyOf)).toEqual(['a', 'b']);
    expect(result.current.newCount).toBe(0);

    rerender({ rows: [{ id: 'b', v: 1 }] });
    expect(result.current.visible.map(keyOf)).toEqual(['b']);
  });

  it('keeps a stable view when the caller passes a fresh empty list on every render', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useHeldRows<Row>([], keyOf);
    });
    expect(result.current.visible).toEqual([]);
    expect(renders).toBeLessThan(5);
  });

  it('starts over when the filters change instead of holding the new result', () => {
    const { result, rerender } = renderHook(
      ({ rows, resetKey }: { rows: Row[]; resetKey: string }) => useHeldRows(rows, keyOf, { resetKey }),
      { initialProps: { rows: [{ id: 'a', v: 1 }], resetKey: 'all' } },
    );
    rerender({ rows: [{ id: 'x', v: 1 }], resetKey: 'client-1' });
    expect(result.current.visible.map(keyOf)).toEqual(['x']);
    expect(result.current.newCount).toBe(0);
  });

  it('never holds the pinned row and keeps it after the pin clears', () => {
    const { result, rerender } = renderHook(
      ({ rows, pinnedId }: { rows: Row[]; pinnedId: string | null }) => useHeldRows(rows, keyOf, { pinnedId }),
      { initialProps: { rows: [{ id: 'a', v: 1 }], pinnedId: null as string | null } },
    );
    rerender({
      rows: [
        { id: 'new', v: 1 },
        { id: 'a', v: 1 },
      ],
      pinnedId: 'new',
    });
    expect(result.current.visible.map(keyOf)).toEqual(['new', 'a']);
    expect(result.current.newCount).toBe(0);

    rerender({
      rows: [
        { id: 'new', v: 1 },
        { id: 'a', v: 1 },
      ],
      pinnedId: null,
    });
    expect(result.current.visible.map(keyOf)).toEqual(['new', 'a']);
    expect(result.current.newCount).toBe(0);
  });
});

describe('useEditConflict', () => {
  it('flags a change made after the form opened, never offline, and clears on dismiss', () => {
    const baseline = { id: 's1', status: 'pending' };
    const { result, rerender } = renderHook(
      ({ record, state }: { record: unknown; state: LiveState }) => useEditConflict(baseline, record, state),
      { initialProps: { record: { id: 's1', status: 'pending' } as unknown, state: 'live' as LiveState } },
    );
    expect(result.current.conflict).toBe(false);

    rerender({ record: { id: 's1', status: 'delivered' }, state: 'offline' });
    expect(result.current.conflict).toBe(false);

    rerender({ record: { id: 's1', status: 'delivered' }, state: 'live' });
    expect(result.current.conflict).toBe(true);

    act(() => result.current.dismiss());
    expect(result.current.conflict).toBe(false);

    rerender({ record: { id: 's1', status: 'failed' }, state: 'live' });
    expect(result.current.conflict).toBe(true);
  });

  it('never conflicts without a baseline', () => {
    const { result } = renderHook(() => useEditConflict(null, { id: 's1' }, 'live'));
    expect(result.current.conflict).toBe(false);
  });
});
