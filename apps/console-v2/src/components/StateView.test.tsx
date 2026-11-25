// StateView.test.tsx — covers the empty/loading/denied/error placeholder.
// Default copy must come from the i18n catalog; an explicit `capability`
// prop must surface a CapabilityLock chip alongside the message.
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { StateView } from './StateView';

describe('StateView', () => {
  it('renders the i18n title for kind="empty"', () => {
    renderWithProviders(<StateView kind="empty" />);
    expect(screen.getByText(/Nothing here yet/i)).toBeInTheDocument();
  });

  it('renders the i18n title for kind="error"', () => {
    renderWithProviders(<StateView kind="error" />);
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
  });

  it('shows the CapabilityLock chip when capability prop is supplied', () => {
    renderWithProviders(
      <StateView kind="denied" capability="finance.read" />,
    );
    expect(screen.getByText('Finance Access permission required')).toBeInTheDocument();
    expect(screen.queryByText('finance.read')).toBeNull();
  });

  it('does not expose technical backend wording in error copy', () => {
    renderWithProviders(
      <StateView
        kind="error"
        title="ui_update_organization_profile_v1 backend readback missing organizations.default_settings"
        hint="VITE_SUPABASE_URL is missing for canonical projection"
      />,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
    expect(screen.queryByText(/backend readback|VITE_SUPABASE_URL|canonical projection/i)).toBeNull();
  });

  it('announces loading through a polite status region and error through an alert', () => {
    const { unmount } = renderWithProviders(<StateView kind="loading" />);
    expect(screen.getByRole('status')).toHaveClass('state--loading');
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();

    renderWithProviders(<StateView kind="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Something went wrong/i);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('adds no live region to the empty and denied states', () => {
    renderWithProviders(<StateView kind="empty" />);
    renderWithProviders(<StateView kind="denied" />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
