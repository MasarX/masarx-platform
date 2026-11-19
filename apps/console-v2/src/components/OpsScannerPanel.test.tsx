import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import {
  OpsScannerPanel,
  classifyScanCode,
  type OpsScannerCandidate,
} from './OpsScannerPanel';

const candidates: OpsScannerCandidate[] = [
  {
    id: 'shipment-1',
    kind: 'shipment',
    kindLabel: 'Shipment',
    label: 'SHP-1001',
    barcodes: ['SHP-1001'],
    actionLabel: 'Record load scan',
    actionDescription: 'Route load scan',
  },
  {
    id: 'driver-1',
    kind: 'driver',
    kindLabel: 'Driver',
    label: 'Driver Ahmed',
    barcodes: ['DRV-77'],
    actionLabel: 'Open driver',
  },
  {
    id: 'basket-1',
    kind: 'basket',
    kindLabel: 'Basket',
    label: 'BASKET-RUH-1',
    barcodes: ['BASKET-RUH-1'],
    actionLabel: 'Open basket',
    resultLabel: 'Basket context opened',
  },
];

describe('OpsScannerPanel', () => {
  it('classifies shipments, drivers, and baskets from one candidate set', () => {
    expect(classifyScanCode('SHP-1001', candidates)).toMatchObject({
      status: 'matched',
      match: { candidate: { kind: 'shipment' }, confidence: 'exact' },
    });
    expect(classifyScanCode('DRV-77', candidates)).toMatchObject({
      status: 'matched',
      match: { candidate: { kind: 'driver' } },
    });
    expect(classifyScanCode('BASKET-RUH-1', candidates)).toMatchObject({
      status: 'matched',
      match: { candidate: { kind: 'basket' } },
    });
  });

  it('matches box-style shipment barcodes by the base tracking number', () => {
    expect(classifyScanCode('SHP-1001:BOX-1', candidates)).toMatchObject({
      status: 'matched',
      match: { candidate: { id: 'shipment-1' }, confidence: 'prefix' },
    });
  });

  it('matches operator-facing route and barcode labels when scanners omit separators', () => {
    expect(
      classifyScanCode('RUN72841', [
        {
          id: 'route-1',
          kind: 'route',
          kindLabel: 'Route',
          label: 'RUN·72841',
          barcodes: ['RUN·72841'],
          actionLabel: 'Open route',
        },
      ]),
    ).toMatchObject({
      status: 'matched',
      match: { candidate: { id: 'route-1' } },
    });
  });

  it('submits the classified match through one scanner action', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderWithProviders(
      <OpsScannerPanel
        candidates={candidates}
        capability="tasks.complete"
        onCommit={onCommit}
      />,
      { capabilities: ['tasks.complete'] },
    );

    await user.type(screen.getByTestId('ops-scanner-input'), 'SHP-1001');
    expect(screen.getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    await user.click(screen.getByRole('button', { name: /Record load scan/i }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toMatchObject({
      candidate: { id: 'shipment-1' },
      matchedBarcode: 'SHP-1001',
    });
  });

  it('keeps the scan pending when the owning backend action rejects', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn().mockRejectedValue(new Error('backend unavailable'));
    renderWithProviders(
      <OpsScannerPanel
        candidates={candidates}
        capability="tasks.complete"
        onCommit={onCommit}
      />,
      { capabilities: ['tasks.complete'] },
    );

    const input = screen.getByTestId('ops-scanner-input');
    await user.type(input, 'SHP-1001');
    await user.click(screen.getByRole('button', { name: /Record load scan/i }));

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Scan action failed')).toBeInTheDocument();
    expect(input).toHaveValue('SHP-1001');
    expect(screen.queryByText('Shipment recorded')).not.toBeInTheDocument();
  });

  it('opens a matched candidate reference without submitting the scan action', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onOpenCandidate = vi.fn();
    renderWithProviders(
      <OpsScannerPanel
        candidates={candidates}
        capability="tasks.complete"
        openCandidateCapability="shipments.read"
        canOpenCandidate={(match) => match.candidate.kind === 'shipment'}
        onOpenCandidate={onOpenCandidate}
        onCommit={onCommit}
      />,
      { capabilities: ['tasks.complete', 'shipments.read'] },
    );

    await user.type(screen.getByTestId('ops-scanner-input'), 'SHP-1001');
    await user.click(screen.getByRole('button', { name: /Open Shipment context SHP-1001/i }));

    expect(onOpenCandidate).toHaveBeenCalledTimes(1);
    expect(onOpenCandidate.mock.calls[0][0]).toMatchObject({
      candidate: { id: 'shipment-1' },
      matchedBarcode: 'SHP-1001',
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('resolves open permissions per matched candidate when the owning screen supplies a capability resolver', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onOpenCandidate = vi.fn();
    renderWithProviders(
      <OpsScannerPanel
        candidates={candidates}
        capability="tasks.complete"
        openCandidateCapability={(match) =>
          match.candidate.kind === 'basket' ? 'baskets.read' : 'shipments.read'
        }
        canOpenCandidate={(match) => ['shipment', 'basket'].includes(match.candidate.kind)}
        onOpenCandidate={onOpenCandidate}
        onCommit={onCommit}
      />,
      { capabilities: ['tasks.complete', 'baskets.read'] },
    );

    await user.type(screen.getByTestId('ops-scanner-input'), 'BASKET-RUH-1');
    const openBasket = screen.getByRole('button', {
      name: /Open Basket context BASKET-RUH-1/i,
    });
    expect(openBasket).toBeEnabled();
    await user.click(openBasket);

    expect(onOpenCandidate).toHaveBeenCalledTimes(1);
    expect(onOpenCandidate.mock.calls[0][0]).toMatchObject({
      candidate: { id: 'basket-1' },
      matchedBarcode: 'BASKET-RUH-1',
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('can gate the primary scanner action with the matched candidate domain capability', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    renderWithProviders(
      <OpsScannerPanel
        candidates={candidates}
        capability="tasks.complete"
        actionCapability={(match) =>
          match?.candidate.kind === 'basket' ? 'baskets.read' : 'tasks.complete'
        }
        onCommit={onCommit}
      />,
      { capabilities: ['baskets.read'] },
    );

    await user.type(screen.getByTestId('ops-scanner-input'), 'BASKET-RUH-1');
    const action = screen.getByRole('button', { name: /Open basket/i });
    expect(action).toBeEnabled();
    await user.click(action);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toMatchObject({
      candidate: { id: 'basket-1' },
      matchedBarcode: 'BASKET-RUH-1',
    });
    expect(screen.getByText('Basket context opened')).toBeInTheDocument();
  });

  it('can record an unmatched scan through the owning screen action', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onNoMatchCommit = vi.fn();
    renderWithProviders(
      <OpsScannerPanel
        candidates={candidates}
        capability="tasks.complete"
        noMatchActionLabel="Record unexpected load scan"
        onCommit={onCommit}
        onNoMatchCommit={onNoMatchCommit}
      />,
      { capabilities: ['tasks.complete'] },
    );

    await user.type(screen.getByTestId('ops-scanner-input'), 'UNEXPECTED-BOX-9');
    expect(screen.getByTestId('ops-scanner-no-match')).toHaveTextContent('No active shipment');
    await user.click(screen.getByRole('button', { name: /Record unexpected load scan/i }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onNoMatchCommit).toHaveBeenCalledWith({
      code: 'UNEXPECTED-BOX-9',
      normalizedCode: 'UNEXPECTED-BOX-9',
    });
  });

  it('locks scanner intake with a visible reason when the owning flow is complete', () => {
    const onCommit = vi.fn();
    renderWithProviders(
      <OpsScannerPanel
        candidates={candidates}
        capability="tasks.complete"
        disabled
        disabledReason="Departure is already confirmed for this route."
        onCommit={onCommit}
      />,
      { capabilities: ['tasks.complete'] },
    );

    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.getByText('Departure is already confirmed for this route.')).toBeInTheDocument();
    expect(screen.getByTestId('ops-scanner-input')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Scan/i })).toBeDisabled();
  });

  it('keeps classification and context opening available when scan actions are locked', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onOpenCandidate = vi.fn();
    renderWithProviders(
      <OpsScannerPanel
        candidates={candidates}
        capability="tasks.complete"
        actionDisabled
        actionDisabledReason="Departure is already confirmed; scan actions are locked."
        openCandidateCapability="shipments.read"
        canOpenCandidate={(match) => match.candidate.kind === 'shipment'}
        onOpenCandidate={onOpenCandidate}
        onCommit={onCommit}
      />,
      { capabilities: ['tasks.complete', 'shipments.read'] },
    );

    const input = screen.getByTestId('ops-scanner-input');
    expect(input).not.toBeDisabled();
    await user.type(input, 'SHP-1001');

    expect(screen.getByTestId('ops-scanner-match')).toHaveTextContent('Shipment');
    expect(screen.getByRole('button', { name: /Record load scan/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Open Shipment context SHP-1001/i }));

    expect(onOpenCandidate).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
