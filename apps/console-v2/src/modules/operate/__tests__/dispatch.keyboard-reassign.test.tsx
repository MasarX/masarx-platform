// WCAG 2.5.7 (#301): a stop moves to another owner from the keyboard, the
// same reassignment the stop-to-run drag performs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { DispatchModule } from '@/modules/operate/dispatch';
import * as ds from '@/lib/data-source';

describe('Dispatch stop reassignment without dragging', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/operate/dispatch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Space selects a stop and Enter on Move selected reassigns it', async () => {
    const user = userEvent.setup();
    const reassignSpy = vi.spyOn(ds, 'ui_execute_route_stop_reassign_v1').mockResolvedValue({
      ok: true,
      count: 1,
      items: [{ target_route_run_id: 'rr_split_target' }],
      assignment_status: 'reassigned',
    } as never);

    renderWithProviders(<DispatchModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(document.querySelectorAll('.dnd-stop').length).toBeGreaterThan(0);
    });

    const checkbox = document.querySelector('.dnd-stop input[type="checkbox"]') as HTMLInputElement;
    checkbox.focus();
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();

    const moveSelected = await screen.findByRole('button', { name: /^Move selected$/i });
    await waitFor(() => expect(moveSelected).not.toBeDisabled());
    moveSelected.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(reassignSpy).toHaveBeenCalledTimes(1));
    const [stopIds] = reassignSpy.mock.calls[0] as [string[]];
    expect(stopIds).toHaveLength(1);
  });
});
