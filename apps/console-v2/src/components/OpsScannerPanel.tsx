import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from './Button';
import { Chip, type ChipKind } from './Chip';
import { Dot } from './Dot';

export interface OpsScannerCandidate {
  id: string;
  kind: string;
  kindLabel?: string;
  label: string;
  description?: string;
  barcodes: Array<string | null | undefined>;
  actionLabel: string;
  actionDescription?: string;
  resultLabel?: string;
  statusLabel?: string;
  statusTone?: ChipKind;
  disabled?: boolean;
  disabledReason?: string;
  payload?: Record<string, unknown>;
}

export interface OpsScannerMatch {
  candidate: OpsScannerCandidate;
  code: string;
  normalizedCode: string;
  matchedBarcode: string;
  confidence: 'exact' | 'prefix';
}

export interface OpsScannerNoMatch {
  code: string;
  normalizedCode: string;
}

export type OpsScannerClassification =
  | { status: 'idle'; matches: [] }
  | { status: 'no-match'; normalizedCode: string; matches: [] }
  | { status: 'matched'; match: OpsScannerMatch; matches: [OpsScannerMatch] }
  | { status: 'ambiguous'; normalizedCode: string; matches: OpsScannerMatch[] };

export function normalizeScanCode(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
}

function scanKeys(value: unknown): string[] {
  const normalized = normalizeScanCode(value);
  if (!normalized) return [];
  const base = normalized.includes(':') ? normalized.split(':')[0] : '';
  const compact = normalized.replace(/[^0-9A-Z]/g, '');
  const compactBase = base.replace(/[^0-9A-Z]/g, '');
  return Array.from(new Set([normalized, base, compact, compactBase].filter(Boolean)));
}

function kindLabel(candidate: OpsScannerCandidate): string {
  if (candidate.kindLabel) return candidate.kindLabel;
  return candidate.kind
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function classifyScanCode(
  rawCode: string,
  candidates: OpsScannerCandidate[],
): OpsScannerClassification {
  const normalizedCode = normalizeScanCode(rawCode);
  if (!normalizedCode) return { status: 'idle', matches: [] };
  const codeKeys = scanKeys(normalizedCode);
  const matches: OpsScannerMatch[] = [];

  for (const candidate of candidates) {
    for (const rawBarcode of candidate.barcodes) {
      const barcodeKeys = scanKeys(rawBarcode);
      if (!barcodeKeys.length) continue;
      const matchedBarcode = barcodeKeys.find((barcode) => codeKeys.includes(barcode));
      if (!matchedBarcode) continue;
      matches.push({
        candidate,
        code: rawCode,
        normalizedCode,
        matchedBarcode,
        confidence: normalizeScanCode(rawBarcode) === normalizedCode ? 'exact' : 'prefix',
      });
      break;
    }
  }

  const uniqueMatches = Array.from(
    new Map(matches.map((match) => [match.candidate.id, match])).values(),
  );
  if (uniqueMatches.length === 0) return { status: 'no-match', normalizedCode, matches: [] };
  if (uniqueMatches.length === 1) {
    return { status: 'matched', match: uniqueMatches[0], matches: [uniqueMatches[0]] };
  }
  return { status: 'ambiguous', normalizedCode, matches: uniqueMatches };
}

export interface OpsScannerPanelProps {
  title?: string;
  contextLabel?: string;
  placeholder?: string;
  candidates: OpsScannerCandidate[];
  disabled?: boolean;
  disabledReason?: string;
  actionDisabled?: boolean | ((match: OpsScannerMatch | null, actionableNoMatch: boolean) => boolean);
  actionDisabledReason?: string | ((match: OpsScannerMatch | null, actionableNoMatch: boolean) => string | undefined);
  busy?: boolean;
  capability?: string;
  actionCapability?: string | ((match: OpsScannerMatch | null) => string | undefined);
  onCommit: (match: OpsScannerMatch) => void | Promise<void>;
  canOpenCandidate?: (match: OpsScannerMatch) => boolean;
  onOpenCandidate?: (match: OpsScannerMatch) => void;
  openCandidateCapability?: string | ((match: OpsScannerMatch) => string | undefined);
  noMatchActionLabel?: string;
  noMatchDescription?: string;
  onNoMatchCommit?: (scan: OpsScannerNoMatch) => void | Promise<void>;
}

export function OpsScannerPanel({
  title = 'Ops scanner',
  contextLabel = 'Universal scan intake',
  placeholder = 'Scan shipment, driver, basket, route, vehicle, or handling unit',
  candidates,
  disabled,
  disabledReason,
  actionDisabled,
  actionDisabledReason,
  busy,
  capability,
  actionCapability,
  onCommit,
  canOpenCandidate,
  onOpenCandidate,
  openCandidateCapability,
  noMatchActionLabel = 'Record unexpected scan',
  noMatchDescription,
  onNoMatchCommit,
}: OpsScannerPanelProps) {
  const [code, setCode] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [lastResult, setLastResult] = useState<{ label: string; tone: ChipKind } | null>(null);
  const classification = useMemo(() => classifyScanCode(code, candidates), [candidates, code]);
  const selectedMatch =
    classification.status === 'matched'
      ? classification.match
      : classification.status === 'ambiguous'
        ? classification.matches.find((match) => match.candidate.id === selectedId) ?? null
        : null;
  const activeMatch =
    classification.status === 'ambiguous'
      ? selectedMatch
      : classification.status === 'matched'
        ? classification.match
        : null;
  const actionableNoMatch = classification.status === 'no-match' && Boolean(onNoMatchCommit);
  const currentActionDisabled =
    typeof actionDisabled === 'function'
      ? actionDisabled(activeMatch, actionableNoMatch)
      : Boolean(actionDisabled);
  const currentActionDisabledReason =
    typeof actionDisabledReason === 'function'
      ? actionDisabledReason(activeMatch, actionableNoMatch)
      : actionDisabledReason;
  const canSubmit = Boolean(
    (activeMatch && !activeMatch.candidate.disabled) ||
    actionableNoMatch,
  ) && !disabled && !currentActionDisabled && !busy;
  const submitCapability =
    typeof actionCapability === 'function'
      ? actionCapability(activeMatch)
      : actionCapability ?? capability;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (currentActionDisabled) return;
    try {
      if (activeMatch) {
        if (activeMatch.candidate.disabled) return;
        await onCommit(activeMatch);
        setLastResult({
          label: activeMatch.candidate.resultLabel ?? `${kindLabel(activeMatch.candidate)} recorded`,
          tone: 'good',
        });
      } else if (classification.status === 'no-match' && onNoMatchCommit) {
        await onNoMatchCommit({
          code,
          normalizedCode: classification.normalizedCode,
        });
        setLastResult({ label: 'Unexpected scan recorded', tone: 'warn' });
      } else {
        return;
      }
    } catch {
      setLastResult({ label: 'Scan action failed', tone: 'danger' });
      return;
    }
    setCode('');
    setSelectedId(null);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <form className="card" data-testid="ops-scanner-panel" onSubmit={(event) => void submit(event)}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div className="eyebrow">{contextLabel}</div>
          <h3 className="state__title" style={{ margin: '2px 0 4px' }}>{title}</h3>
        </div>
        <Chip
          size="xs"
          kind={
            disabled
              ? 'neutral'
              : currentActionDisabled
              ? 'neutral'
              : classification.status === 'matched'
              ? 'good'
              : classification.status === 'ambiguous'
                ? 'warn'
                : classification.status === 'no-match'
                  ? 'danger'
                  : 'info'
          }
          label={
            disabled
              ? 'Locked'
              : currentActionDisabled
              ? 'Action locked'
              : classification.status === 'matched'
              ? kindLabel(classification.match.candidate)
              : classification.status === 'ambiguous'
                ? `${classification.matches.length} matches`
                : classification.status === 'no-match'
                  ? 'No match'
                  : 'Ready'
          }
        />
      </div>

      <div className="field" style={{ marginTop: 10 }}>
        <label className="field__label">Scan code</label>
        <input
          ref={inputRef}
          data-testid="ops-scanner-input"
          className="field__input mono"
          placeholder={placeholder}
          value={code}
          disabled={disabled || busy}
          onChange={(event) => {
            setCode(event.target.value);
            setSelectedId(null);
          }}
        />
      </div>

      {classification.status === 'matched' ? (
        <ScanMatchPreview
          match={classification.match}
          canOpenCandidate={canOpenCandidate}
          onOpenCandidate={onOpenCandidate}
          openCandidateCapability={openCandidateCapability}
        />
      ) : classification.status === 'ambiguous' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          {classification.matches.slice(0, 5).map((match) => (
            <button
              key={match.candidate.id}
              type="button"
              data-testid="ops-scanner-ambiguous-match"
              aria-pressed={selectedId === match.candidate.id}
              onClick={() => setSelectedId(match.candidate.id)}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: 10,
                textAlign: 'left',
                borderColor: selectedId === match.candidate.id ? 'var(--accent)' : 'var(--line)',
              }}
            >
              <ScanMatchPreview match={match} compact />
            </button>
          ))}
        </div>
      ) : classification.status === 'no-match' ? (
        <div className="state__hint" data-testid="ops-scanner-no-match">
          {noMatchDescription ??
            'No active shipment, driver, basket, route, vehicle, or handling-unit match was found in this screen context.'}
        </div>
      ) : (
        <div className="state__hint">
          {disabled && disabledReason
            ? disabledReason
            : currentActionDisabled && currentActionDisabledReason
            ? currentActionDisabledReason
            : 'Ready for scan intake.'}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <div>
          {lastResult ? <Chip size="xs" kind={lastResult.tone} label={lastResult.label} /> : null}
        </div>
        <Button
          type="submit"
          iconName="scan"
          kind="primary"
          label={activeMatch?.candidate.actionLabel ?? (actionableNoMatch ? noMatchActionLabel : 'Scan')}
          capability={submitCapability}
          disabled={!canSubmit}
          title={activeMatch?.candidate.disabledReason ?? currentActionDisabledReason ?? disabledReason}
        />
      </div>
    </form>
  );
}

function ScanMatchPreview({
  match,
  compact = false,
  canOpenCandidate,
  onOpenCandidate,
  openCandidateCapability,
}: {
  match: OpsScannerMatch;
  compact?: boolean;
  canOpenCandidate?: (match: OpsScannerMatch) => boolean;
  onOpenCandidate?: (match: OpsScannerMatch) => void;
  openCandidateCapability?: string | ((match: OpsScannerMatch) => string | undefined);
}) {
  const candidate = match.candidate;
  const canOpen = Boolean(!compact && onOpenCandidate && (canOpenCandidate?.(match) ?? true));
  const capability =
    typeof openCandidateCapability === 'function'
      ? openCandidateCapability(match)
      : openCandidateCapability;
  return (
    <div data-testid="ops-scanner-match" style={{ display: 'grid', gap: compact ? 4 : 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Dot kind={candidate.disabled ? 'warn' : 'good'} />
        {canOpen ? (
          <Button
            type="button"
            kind="ghost"
            size="sm"
            label={candidate.label}
            iconName="eye"
            capability={capability}
            ariaLabel={`Open ${kindLabel(candidate)} context ${candidate.label}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenCandidate?.(match);
            }}
          />
        ) : (
          <strong>{candidate.label}</strong>
        )}
        <Chip size="xs" kind={candidate.statusTone ?? 'info'} label={kindLabel(candidate)} />
        {candidate.statusLabel ? <Chip size="xs" kind={candidate.statusTone ?? 'neutral'} label={candidate.statusLabel} /> : null}
      </div>
      {candidate.description ? <div className="state__hint">{candidate.description}</div> : null}
      <div className="mono" style={{ fontSize: 11 }}>
        {candidate.actionDescription ?? candidate.actionLabel} · {match.matchedBarcode}
      </div>
      {candidate.disabled && candidate.disabledReason ? (
        <div className="state__hint">{candidate.disabledReason}</div>
      ) : null}
    </div>
  );
}
