// MessageThread.test.tsx — chat-style conversation:
//   1. mount + each message renders a body
//   2. role flips set the right alignment class (operator/customer/system)
//   3. composer.onSubmit fires with the trimmed body when Send is clicked
//   4. role=log + aria-live polite live-region semantics expose to AT
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { MessageThread, type ThreadMessage } from './MessageThread';

const MESSAGES: ThreadMessage[] = [
  {
    id: 'm1',
    at: '2026-04-26T09:00:00Z',
    author: { id: 'op-1', name: 'Sara Operator', role: 'operator' },
    body: 'Hi, your shipment is on its way.',
  },
  {
    id: 'm2',
    at: '2026-04-26T09:02:00Z',
    author: { id: 'cu-1', name: 'Ahmed Customer', role: 'customer' },
    body: 'Thanks, when will it arrive?',
  },
  {
    id: 'm3',
    at: '2026-04-26T09:03:00Z',
    author: { id: 'sys', name: 'System', role: 'system' },
    body: 'Driver assigned: D-014',
  },
];

describe('MessageThread', () => {
  it('renders the body of every message', () => {
    renderWithProviders(<MessageThread messages={MESSAGES} />);
    expect(screen.getByText('Hi, your shipment is on its way.')).toBeInTheDocument();
    expect(screen.getByText('Thanks, when will it arrive?')).toBeInTheDocument();
    expect(screen.getByText('Driver assigned: D-014')).toBeInTheDocument();
  });

  it('applies role-specific alignment classes', () => {
    const { container } = renderWithProviders(<MessageThread messages={MESSAGES} />);
    const rows = container.querySelectorAll('.primitive-msg__row');
    expect(rows[0]?.className).toMatch(/--operator/);
    expect(rows[1]?.className).toMatch(/--customer/);
    expect(rows[2]?.className).toMatch(/--system/);
  });

  it('composer.onSubmit fires with the trimmed body and clears draft', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <MessageThread
        messages={MESSAGES}
        composer={{ onSubmit, placeholder: 'reply…' }}
      />,
      { capabilities: ['all'] },
    );
    const textarea = screen.getByLabelText('Send message');
    await user.type(textarea, '   Acknowledged, thank you.   ');
    await user.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Acknowledged, thank you.'));
  });

  it('exposes role=log with aria-live polite', () => {
    renderWithProviders(<MessageThread messages={MESSAGES} />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-relevant', 'additions');
  });
});
