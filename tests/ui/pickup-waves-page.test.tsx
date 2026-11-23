import { fireEvent, screen, within } from '@testing-library/react';
import { PickupWavesPage } from '../../packages/ui/src/pickup-waves-page';
import { renderWithIntl } from './test-utils';
const uiRpc = jest.fn();
const readRpc = jest.fn();
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('@masarx/api/server', () => ({ createUiServerClient: () => ({
  me: async () => ({ org: { id: 'org-a' }, capabilities: ['fleet.write'] }), rpc: uiRpc,
}) }));
jest.mock('@masarx/auth/server', () => ({ createServerClient: () => ({ rpc: readRpc }) }));

describe('pickup wave relationship scope', () => {
  it('never offers actor-tenant driver choices for a platform-visible different-tenant wave', async () => {
    readRpc.mockImplementation(async (name: string) => ({ data: name === 'pickup_waves_list_v1'
      ? [{ route_run_id: 'route-b', organization_id: 'org-b', shipments: [] }] : [], error: null }));
    uiRpc.mockImplementation(async (name: string) => name === 'pickup_assignment_options_v1'
      ? { branches: [], drivers: [{ value: 'driver-a', label: 'Actor tenant driver' }], vehicles: [], partners: [] }
      : { 'route:route-b': { driver_label: 'Correct route driver' } });
    renderWithIntl(await PickupWavesPage({ appKey: 'console', appBasePath: '/console', searchParams: {}, testIdPrefix: 'pickup' }));
    expect(screen.getByText('Select pickup requests from the ledger or enter authorized shipment IDs directly.')).toBeInTheDocument();
    expect(screen.getByText('Correct route driver')).toBeInTheDocument();
    const driver = within(screen.getByTestId('pickup-assign-driver-route-b-driver_user_id')).getByRole('combobox', { name: 'Driver' });
    fireEvent.keyDown(driver, { key: 'Enter' });
    expect(screen.queryByRole('option', { name: 'Actor tenant driver' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Driver IDs')).toBeInTheDocument();
  });
});
