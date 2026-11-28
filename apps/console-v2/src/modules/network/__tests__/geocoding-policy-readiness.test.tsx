import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderWithProviders } from '@/test/render';
import { GeocodingModule } from '../geocoding';

it('offers geocoding configuration once the scope registry is available', async () => {
  const user = userEvent.setup();
  let releaseScopeRegistry!: () => void;
  const scopeRegistryPending = new Promise<void>((resolve) => {
    releaseScopeRegistry = resolve;
  });
  const listResource = api.ui_list_resource_v1;
  const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, options) => {
    if (resource === 'scope_type_registry') await scopeRegistryPending;
    return listResource(resource, options);
  });

  try {
    renderWithProviders(<GeocodingModule />, { capabilities: ['all'] });
    await user.click(screen.getByRole('tab', { name: /Policy & attempts/i }));

    expect(listSpy).toHaveBeenCalledWith('scope_type_registry', undefined);
    const configure = { name: /Configure Geocoding/i };
    expect(screen.queryByRole('button', configure)).not.toBeInTheDocument();

    releaseScopeRegistry();
    const button = await screen.findByRole('button', configure);
    expect(button).toBeEnabled();
    await user.click(button);

    expect(await screen.findByRole('dialog', configure)).toBeVisible();
    expect(screen.getByTestId('change-request-form')).toBeInTheDocument();
  } finally {
    releaseScopeRegistry();
    listSpy.mockRestore();
  }
});

it('names the missing scope types when the scope registry has no rows', async () => {
  const user = userEvent.setup();
  const listResource = api.ui_list_resource_v1;
  const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (resource, options) => {
    if (resource === 'scope_type_registry') {
      return { rows: [], total: 0, page: 0, page_size: 50 } as Awaited<ReturnType<typeof listResource>>;
    }
    return listResource(resource, options);
  });

  try {
    renderWithProviders(<GeocodingModule />, { capabilities: ['all'] });
    await user.click(screen.getByRole('tab', { name: /Policy & attempts/i }));

    expect(await screen.findByText('No scope types registered')).toBeInTheDocument();
    expect(screen.getByText(/scope type registry has no rows/i)).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Configure Geocoding/i })).not.toBeInTheDocument();
  } finally {
    listSpy.mockRestore();
  }
});
