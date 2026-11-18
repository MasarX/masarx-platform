// Drawer.test.tsx — covers the Drawer's controlled open/close contract,
// keyboard escape, and the optional deep-link affordance. The component is
// backed by Radix Dialog primitives so the focus trap + escape handling are
// asserted at the public-API level (do we close? does aria-label flow?).
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('renders body content when open=true', async () => {
    renderWithProviders(
      <Drawer open title="Test Drawer" onClose={() => {}}>
        <p>drawer body</p>
      </Drawer>,
    );
    expect(screen.getByText('drawer body')).toBeInTheDocument();
    // The Radix Title renders the title visibly; a hidden Description duplicates
    // it for AT semantics, so we assert at least one match exists.
    expect(screen.getAllByText('Test Drawer').length).toBeGreaterThan(0);
    expect(document.querySelector('.drawer')).toHaveAttribute('data-state', 'open');
    await waitFor(() => expect(document.querySelector('.drawer-root')).toHaveClass('is-open'));
  });

  it('does not render content when open=false', () => {
    renderWithProviders(
      <Drawer open={false} title="Closed" onClose={() => {}}>
        <p>hidden body</p>
      </Drawer>,
    );
    expect(screen.queryByText('hidden body')).not.toBeInTheDocument();
  });

  it('Escape key triggers onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <Drawer open title="Dismiss" onClose={onClose}>
        <p>body</p>
      </Drawer>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('Close button triggers onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <Drawer open title="Closeable" onClose={onClose}>
        <p>body</p>
      </Drawer>,
    );
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the deep-link button when deepLink prop is provided', () => {
    renderWithProviders(
      <Drawer open title="Deep" onClose={() => {}} deepLink="/some/path">
        <p>body</p>
      </Drawer>,
    );
    expect(screen.getByLabelText('Open in new tab')).toBeInTheDocument();
  });
});
