// auth-email.test.tsx — verifies the read-only chip is present, callback +
// redirect URLs render with copy affordances, and the source file path is
// displayed.

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { AuthEmailModule } from '@/modules/platform/auth-email';

describe('AuthEmailModule', () => {
  it('renders read-only chip and source file path', async () => {
    renderWithProviders(<AuthEmailModule />);
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(await screen.findByText(/auth-email-url-policy/i)).toBeInTheDocument();
  });

  it('renders environment audit chip', async () => {
    renderWithProviders(<AuthEmailModule />);
    expect(await screen.findByText(/audit green/i)).toBeInTheDocument();
  });

  it('renders copy-able URL list items', async () => {
    renderWithProviders(<AuthEmailModule />);
    const copyButtons = await screen.findAllByTestId('auth-email-copy-url');
    expect(copyButtons.length).toBeGreaterThan(0);
  });

  it('exposes a Copy raw JSON action', async () => {
    renderWithProviders(<AuthEmailModule />);
    expect(await screen.findByRole('button', { name: /Copy raw JSON/i })).toBeInTheDocument();
  });
});
