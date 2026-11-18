// Button.test.tsx — covers label rendering and the canonical capability gate:
// when a `capability` is required and the user does not hold it, the Button is
// disabled and a CapabilityLock chip is appended.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { Button } from './Button';

describe('Button', () => {
  it('renders the supplied label', () => {
    renderWithProviders(<Button label="Save" />, { capabilities: ['all'] });
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('disables itself + shows the lock chip when capability is missing', () => {
    renderWithProviders(<Button label="Approve" capability="finance.write" />, {
      capabilities: ['shipments.read'], // no finance.write
    });
    const btn = screen.getByRole('button', { name: /Approve/ });
    expect(btn).toBeDisabled();
    expect(screen.getByText('Finance Update permission required')).toBeInTheDocument();
    expect(screen.queryByText('finance.write')).toBeNull();
  });

  it('does not invoke onClick when the capability gate is closed', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <Button label="Run" capability="ops.execute" onClick={onClick} />,
      { capabilities: [] },
    );
    await user.click(screen.getByRole('button', { name: /Run/ }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('allows an action when any one accepted capability is present', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <Button
        label="Request change"
        anyCapabilities={['settings.write', 'system.write']}
        onClick={onClick}
      />,
      { capabilities: ['system.write'] },
    );

    await user.click(screen.getByRole('button', { name: 'Request change' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables an any-capability action when none of the accepted capabilities are present', () => {
    renderWithProviders(
      <Button label="Request change" anyCapabilities={['settings.write', 'system.write']} />,
      { capabilities: ['settings.read'] },
    );

    const btn = screen.getByRole('button', { name: /Request change/ });
    expect(btn).toBeDisabled();
    expect(screen.getByText('Settings Write permission required')).toBeInTheDocument();
    expect(screen.getByText('System Write permission required')).toBeInTheDocument();
  });
});
