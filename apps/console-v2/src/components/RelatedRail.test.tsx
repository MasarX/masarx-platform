// RelatedRail.test.tsx — covers the universal tabbed inline panel:
// renders tabs with counts, clicking a tab swaps the body, async render
// promises resolve into content, and rejection surfaces as an error state.
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { RelatedRail, type RelatedTab } from './RelatedRail';

const baseTabs: RelatedTab[] = [
  { id: 'a', label: 'Alpha', count: 3, render: () => <p>alpha body</p> },
  { id: 'b', label: 'Bravo', count: 1, render: () => <p>bravo body</p> },
];

describe('RelatedRail', () => {
  it('renders all tabs with the supplied counts', async () => {
    renderWithProviders(<RelatedRail tabs={baseTabs} defaultTab="a" />);
    // Tabs render synchronously; the body renders via an async effect, so we
    // wait for the body to settle before asserting on the tab strip — this
    // avoids "update not wrapped in act(...)" warnings from React.
    await waitFor(() => expect(screen.getByText('alpha body')).toBeInTheDocument());
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders the default tab body once it resolves', async () => {
    renderWithProviders(<RelatedRail tabs={baseTabs} defaultTab="a" />);
    await waitFor(() => expect(screen.getByText('alpha body')).toBeInTheDocument());
  });

  it('clicking a different tab swaps the body content', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RelatedRail tabs={baseTabs} defaultTab="a" />);
    await waitFor(() => expect(screen.getByText('alpha body')).toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: /Bravo/ }));
    await waitFor(() => expect(screen.getByText('bravo body')).toBeInTheDocument());
    expect(screen.queryByText('alpha body')).not.toBeInTheDocument();
  });

  it('async render Promise resolves into content', async () => {
    const tabs: RelatedTab[] = [
      {
        id: 'lazy',
        label: 'Lazy',
        render: () => Promise.resolve(<p>lazy body</p>),
      },
    ];
    renderWithProviders(<RelatedRail tabs={tabs} defaultTab="lazy" />);
    await waitFor(() => expect(screen.getByText('lazy body')).toBeInTheDocument());
  });

  it('renders the error state when render() rejects', async () => {
    const tabs: RelatedTab[] = [
      {
        id: 'broken',
        label: 'Broken',
        render: () => Promise.reject(new Error('boom')),
      },
    ];
    renderWithProviders(<RelatedRail tabs={tabs} defaultTab="broken" />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
