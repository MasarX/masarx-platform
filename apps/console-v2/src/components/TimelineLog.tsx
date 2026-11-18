// TimelineLog.tsx — vertical event timeline.
//
// Events render as a stack of expandable rows along a vertical line; bullet
// markers carry tone color. Rows auto-group into "Today" / "Yesterday" /
// "This week" / "Earlier" buckets derived from the `at` timestamp. Each row is
// a `<button aria-expanded>`; the expanded panel is `role="region"` so screen
// readers announce it as a landmark when opened.
//
// W49 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
// bucket labels and rendering order are sourced from canonical
// `ui_presentation_policy.timeline_buckets.{labels,order}` via
// `useResolveSettings`. While the policy is unresolved, the timeline renders
// an empty body (no rows) so missing seeds surface visibly. If the canonical
// rows are missing, an explicit danger placeholder takes the surface so the
// gap is not silently masked.
import { useMemo, useState, type ReactNode } from 'react';
import { useResolveSettings } from '@/lib/queries';

export type TimelineTone = 'good' | 'warn' | 'danger' | 'neutral';

export interface TimelineEvent {
  id: string;
  /** ISO timestamp. */
  at: string;
  /** Stable event-type code, e.g. 'invoice.sent'. Rendered as an inline chip. */
  type: string;
  actor?: string;
  summary: string;
  detail?: ReactNode;
  tone?: TimelineTone;
}

export interface TimelineLogProps {
  events: TimelineEvent[];
  /** Event ids that should start expanded. */
  initiallyExpanded?: string[];
  className?: string;
  /** Inject a fixed reference time for deterministic tests. */
  now?: string | Date;
}

type BucketKey = 'today' | 'yesterday' | 'this_week' | 'earlier';

const DAY_MS = 86_400_000;

function bucketFor(at: Date, now: Date): BucketKey {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = startOfDay.getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  if (diff <= 0) return 'today';
  if (diff <= DAY_MS) return 'yesterday';
  if (diff <= DAY_MS * 6) return 'this_week';
  return 'earlier';
}

function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TimelineLog({ events, initiallyExpanded, className, now }: TimelineLogProps) {
  const referenceNow = useMemo(() => (now ? new Date(now) : new Date()), [now]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initiallyExpanded ?? []));

  // Canonical UX-presentation policy — SSOT for bucket labels and rendering
  // order. Caller-supplied props are intentionally not exposed: the timeline
  // grouping vocabulary is a system-wide presentation choice and must stay
  // tenant/source-overridable through the override ladder, not at the call
  // site.
  const policy = useResolveSettings('ui_presentation_policy', undefined);
  const policyValue = policy.data?.value as
    | {
        timeline_buckets?: {
          labels?: Partial<Record<BucketKey, string>>;
          order?: BucketKey[];
        };
      }
    | undefined;
  const bucketLabels = policyValue?.timeline_buckets?.labels;
  const bucketOrder = policyValue?.timeline_buckets?.order;

  const grouped = useMemo(() => {
    const sorted = events.slice().sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const map: Record<BucketKey, TimelineEvent[]> = {
      today: [],
      yesterday: [],
      this_week: [],
      earlier: [],
    };
    for (const ev of sorted) {
      const at = new Date(ev.at);
      if (Number.isNaN(at.getTime())) continue;
      map[bucketFor(at, referenceNow)].push(ev);
    }
    return map;
  }, [events, referenceNow]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const wrapClasses = ['primitive-tl', className].filter(Boolean).join(' ');

  // While the canonical policy is loading, render an empty timeline frame so
  // layout stays stable but no rows appear without resolved bucket labels.
  if (policy.isLoading) {
    return <div className={wrapClasses} />;
  }

  // Strict no-fallback: missing canonical rows render an explicit danger
  // placeholder so operators see the gap rather than silent masking.
  if (
    !bucketLabels ||
    !bucketOrder ||
    bucketOrder.length === 0 ||
    bucketOrder.some((k) => bucketLabels[k] == null)
  ) {
    return (
      <div className={wrapClasses}>
        <div className="primitive-tl__group-label" role="alert">
          Timeline labels are not configured.
        </div>
      </div>
    );
  }

  return (
    <div className={wrapClasses}>
      {bucketOrder.map((bucket) => {
        const items = grouped[bucket];
        if (items.length === 0) return null;
        return (
          <section key={bucket} className="primitive-tl__group">
            <header className="primitive-tl__group-label">{bucketLabels[bucket]}</header>
            {items.map((ev) => {
              const at = new Date(ev.at);
              const tone = ev.tone ?? 'neutral';
              const isOpen = expanded.has(ev.id);
              const detailId = `${ev.id}-detail`;
              return (
                <div key={ev.id}>
                  <button
                    type="button"
                    className="primitive-tl__row"
                    aria-expanded={ev.detail ? isOpen : undefined}
                    aria-controls={ev.detail ? detailId : undefined}
                    onClick={() => ev.detail && toggle(ev.id)}
                  >
                    <span className={`primitive-tl__bullet primitive-tl__bullet--${tone}`} />
                    <span className="primitive-tl__head">
                      <span className="primitive-tl__time">{fmtTime(at)}</span>
                      <span className="primitive-tl__type">{ev.type}</span>
                      {ev.actor ? <span className="primitive-tl__actor">{ev.actor}</span> : null}
                      {ev.detail ? <span className="primitive-tl__expand">▾</span> : null}
                    </span>
                    <div className="primitive-tl__summary">{ev.summary}</div>
                  </button>
                  {ev.detail && isOpen ? (
                    <div
                      id={detailId}
                      role="region"
                      aria-label={`${ev.type} details`}
                      className="primitive-tl__detail"
                    >
                      {ev.detail}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
