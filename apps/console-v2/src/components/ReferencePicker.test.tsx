// ReferencePicker.test.tsx — covers the picker's wiring around `Palette`:
// it must turn a typed `source` into selectable items, fire onPick with the
// correct value, and dismiss on Escape.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { ReferencePicker, type ReferenceSource } from './ReferencePicker';

// `PickerSource` (the prop on `ReferencePicker`) only accepts the default
// `ReferenceSource<Record<string, unknown>>` shape, so we keep the row type
// as a plain record and access fields with string keys.
const SAMPLE_ITEMS: Array<Record<string, unknown>> = [
  { id: 'h_1', label: 'Riyadh hub', region: 'central' },
  { id: 'h_2', label: 'Jeddah hub', region: 'west' },
  { id: 'h_3', label: 'Dammam hub', region: 'east' },
];

const referenceSource: ReferenceSource = {
  kind: 'reference',
  items: SAMPLE_ITEMS,
  display: (r) => String(r.label ?? ''),
  value: (r) => r.id,
  sub: (r) => String(r.region ?? ''),
  section: 'Hubs',
};

describe('ReferencePicker', () => {
  it('renders an item per row from the source', () => {
    renderWithProviders(
      <ReferencePicker
        open
        title="Pick hub"
        source={referenceSource}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Riyadh hub')).toBeInTheDocument();
    expect(screen.getByText('Jeddah hub')).toBeInTheDocument();
    expect(screen.getByText('Dammam hub')).toBeInTheDocument();
  });

  it('clicking an item fires onPick with the source value() result', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    renderWithProviders(
      <ReferencePicker
        open
        title="Pick hub"
        source={referenceSource}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByText('Jeddah hub'));
    expect(onPick).toHaveBeenCalled();
    expect(onPick.mock.calls[0]?.[0]).toBe('h_2');
  });

  it('Escape key triggers onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <ReferencePicker
        open
        title="Pick hub"
        source={referenceSource}
        onPick={() => {}}
        onClose={onClose}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
