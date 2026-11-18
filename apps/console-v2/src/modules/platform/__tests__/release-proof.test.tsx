import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ReleaseProofModule } from '@/modules/platform/release-proof';

describe('ReleaseProofModule', () => {
  it('renders configured same-SHA proof rows including Console V2 deploy evidence', async () => {
    renderWithProviders(<ReleaseProofModule />, { capabilities: ['settings.read'] });

    expect(await screen.findByRole('heading', { name: /Release proof/i })).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(await screen.findByText('deploy-stg-promote.yml')).toBeInTheDocument();
    expect(screen.queryByText('missing_evidence_contract')).not.toBeInTheDocument();
    expect(await screen.findByText('console-stg-deploy-evidence')).toBeInTheDocument();
    expect((await screen.findAllByText('console-deploy-evidence-manifest.json')).length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('deploy-console.yml').length).toBeGreaterThanOrEqual(3);
  });

  it('shows KPI totals from the row-driven proof resource', async () => {
    renderWithProviders(<ReleaseProofModule />, { capabilities: ['settings.read'] });
    const kpis = await screen.findByTestId('release-proof-kpis');

    expect(within(kpis).getByText('Proof rows')).toBeInTheDocument();
    expect(within(kpis).getAllByText('15').length).toBeGreaterThanOrEqual(2);
    expect(within(kpis).getByText('Configured')).toBeInTheDocument();
    expect(within(kpis).getAllByText('15').length).toBeGreaterThanOrEqual(2);
    expect(within(kpis).getByText('Evidence gaps')).toBeInTheDocument();
    expect(within(kpis).getByText('Console gaps')).toBeInTheDocument();
    expect(within(kpis).getAllByText('0').length).toBeGreaterThanOrEqual(2);
  });

  it('denies the page when settings.read is missing', async () => {
    renderWithProviders(<ReleaseProofModule />, { capabilities: [] });

    expect(await screen.findByText(/Release proof governance requires settings permission/i)).toBeInTheDocument();
    expect(screen.queryByText('deploy-stg-promote.yml')).not.toBeInTheDocument();
  });
});
