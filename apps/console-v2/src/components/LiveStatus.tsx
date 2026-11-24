// LiveStatus.tsx — live-refresh pieces (#405): LiveChip, StaleBanner,
// StaleLabel, NewRowsStrip, WriteOffReason and ConflictToast. The LiveChip's
// label is the page's only connection live region; banners and labels are not
// live regions, and the ticking age sits outside the region.
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import type { LiveConnection, LiveState } from '@/lib/live-connection';
import { Button } from './Button';

const CHIP_KIND: Record<LiveState, string> = {
  syncing: 'info',
  live: 'good',
  reconnecting: 'warn',
  offline: 'danger',
  polling: 'neutral',
};
const DOT_CLASS: Record<LiveState, string> = {
  syncing: 'live-spinner',
  live: 'dot dot--good dot--pulse',
  reconnecting: 'dot dot--warn dot--hollow',
  offline: 'dot dot--danger',
  polling: 'dot',
};

function isStale(state: LiveState) {
  return state === 'reconnecting' || state === 'offline';
}

function fill(message: string, key: string, value: string): ReactNode {
  const [before, after = ''] = message.split(`{${key}}`);
  return (
    <>
      {before}
      <bdi>{value}</bdi>
      {after}
    </>
  );
}

/** Short duration in the user's locale, e.g. "4s", "2m". */
export function useFmtAge() {
  const { fmtNumber } = useI18n();
  return (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const [n, unit]: [number, string] = s < 60 ? [s, 'second'] : s < 3600 ? [Math.floor(s / 60), 'minute'] : [Math.floor(s / 3600), 'hour'];
    return fmtNumber(n, { style: 'unit', unit, unitDisplay: 'narrow' });
  };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function LiveChip({ live }: { live: LiveConnection }) {
  const { t, fmtTime } = useI18n();
  const fmtAge = useFmtAge();
  const { state, syncedAt } = live;
  const now = useNow(state === 'live' || state === 'reconnecting');
  const age = fmtAge(now - syncedAt);
  const detail =
    state === 'live'
      ? <bdi>{age}</bdi>
      : state === 'reconnecting'
        ? fill(t('live.lastUpdate'), 'age', age)
        : state === 'offline'
          ? fill(t('live.dataFrom'), 'time', fmtTime(syncedAt))
          : state === 'polling'
            ? <bdi>{fmtAge(live.pollMs)}</bdi>
            : null;
  return (
    <span className="live-chip" data-testid="live-chip" data-state={state}>
      <span
        className={`chip chip--${CHIP_KIND[state]}`}
        title={state === 'live' ? t('live.connectedTitle').replace('{age}', age) : undefined}
      >
        <span className={DOT_CLASS[state]} aria-hidden="true" />
        <span role="status">{t(`live.state.${state}`)}</span>
        {detail ? <span>&nbsp;· {detail}</span> : null}
      </span>
      {isStale(state) ? <Button kind="ghost" label={t('common.retry')} onClick={live.retry} /> : null}
    </span>
  );
}

export function StaleBanner({ live }: { live: LiveConnection }) {
  const { t, fmtTime } = useI18n();
  if (!isStale(live.state)) return null;
  const offline = live.state === 'offline';
  return (
    <div className={`stale-banner${offline ? ' stale-banner--danger' : ''}`} data-testid="stale-banner">
      {fill(t(offline ? 'live.offlineBanner' : 'live.pausedBanner'), 'time', fmtTime(live.syncedAt))}
    </div>
  );
}

export function StaleLabel({ live }: { live: LiveConnection }) {
  const { t, fmtTime } = useI18n();
  if (!isStale(live.state)) return null;
  return <div className="stale-label">{fill(t('live.dataFromLabel'), 'time', fmtTime(live.syncedAt))}</div>;
}

/** "N new runs · Show". The status span stays mounted so the count is announced when it appears. */
export function NewRowsStrip({ count, path, onShow }: { count: number; path: string; onShow: () => void }) {
  const { t, tCount } = useI18n();
  return (
    <div className={count > 0 ? 'new-rows' : 'new-rows new-rows--empty'} data-testid="new-rows">
      {count > 0 ? <span className="dot dot--info" aria-hidden="true" /> : null}
      <span role="status">{count > 0 ? tCount(path, count) : ''}</span>
      {count > 0 ? (
        <>
          <span className="new-rows__grow" />
          <Button label={t('live.show')} onClick={onShow} />
        </>
      ) : null}
    </div>
  );
}

/**
 * While offline, write actions stay focusable but paused: pass `reasonId` to
 * each Button's `pausedReasonId` and render `reason` next to them.
 */
export function useWritePause(live: LiveConnection) {
  const { t } = useI18n();
  const reasonId = useId();
  const paused = live.state === 'offline';
  return {
    reasonId: paused ? reasonId : undefined,
    reason: paused ? (
      <span className="write-off" id={reasonId} key="write-off">
        {t('live.reconnectToSave')}
      </span>
    ) : null,
  };
}

/** Edit conflict notice. Render it inside the open edit form (see ConflictSlot): a modal makes the page behind it inert. */
export function ConflictToast({ title, onReview, onKeep }: { title: string; onReview: () => void; onKeep: () => void }) {
  const { t } = useI18n();
  return (
    <div className="toast toast--conflict" role="alert" data-testid="conflict-toast">
      <b>{title}</b>
      <span>{t('live.conflict.body')}</span>
      <div className="toast__actions">
        <Button kind="primary" label={t('live.conflict.review')} onClick={onReview} />
        <Button kind="ghost" label={t('live.conflict.keep')} onClick={onKeep} />
      </div>
    </div>
  );
}

const ConflictContext = createContext<ReactNode>(null);
/** Wrap an overlay whose body is built once at open time, so ConflictSlot inside it stays current. */
export const ConflictProvider = ConflictContext.Provider;
export function ConflictSlot() {
  return <>{useContext(ConflictContext)}</>;
}
