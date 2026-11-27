import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { LiveState } from '@/lib/live-connection';
import { useEditConflict, useHeldRows } from './live-rows';

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
