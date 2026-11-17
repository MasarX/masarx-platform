import { loadPickupAssignmentOptions, loadPickupRelationshipOptions, loadPickupRequestRows } from '../../packages/ui/src/pickup-page-shared';
const listResource = jest.fn();
const uiRpc = jest.fn();
const readRpc = jest.fn();
jest.mock('@masarx/api/server', () => ({ createUiServerClient: () => ({ listResource, rpc: uiRpc }) }));
jest.mock('@masarx/auth/server', () => ({ createServerClient: () => ({ rpc: readRpc }) }));

describe('pickup choices and readable scoped rows', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('uses the existing sender registry and carries its client grouping', async () => {
    listResource.mockResolvedValue({ items: [{ id: 'sender-a', client_id: 'client-a', name: 'Sender A' }] });
    expect(await loadPickupRelationshipOptions('senders', 'client-a')).toEqual({
      options: [{ value: 'sender-a', label: 'Sender A', groupValue: 'client-a' }], error: null,
    });
    expect(listResource).toHaveBeenCalledWith('senders', { client_id: 'client-a' }, 200, 0);
  });
  it('reports denied assignment lookups instead of falling back to raw tables', async () => {
    uiRpc.mockRejectedValue(new Error('scope denied'));
    const result = await loadPickupAssignmentOptions('organization-a');
    expect(result.error).toContain('scope denied');
    expect(result.options.drivers).toEqual([]);
    expect(listResource).not.toHaveBeenCalled();
  });
  it('asks for labels only for the actual scoped list result', async () => {
    readRpc.mockResolvedValue({ data: [{ shipment_id: 'visible-a', client_id: 'client-a' }], error: null });
    uiRpc.mockResolvedValue({ 'shipment:visible-a': { client_label: 'Client A' }, 'shipment:hidden': { client_label: 'Secret' } });
    const result = await loadPickupRequestRows({ clientId: 'client-a' });
    expect(uiRpc).toHaveBeenCalledWith('pickup_relationship_labels_v1', { p_shipment_ids: ['visible-a'], p_route_run_ids: [] });
    expect(result.rows).toEqual([{ shipment_id: 'visible-a', client_id: 'client-a', client_label: 'Client A' }]);
  });
  it('retains visible rows and reports an independent labels failure', async () => {
    readRpc.mockResolvedValue({ data: [{ shipment_id: 'visible-a' }], error: null });
    uiRpc.mockRejectedValue(new Error('labels unavailable'));
    const result = await loadPickupRequestRows({});
    expect(result.rows).toEqual([{ shipment_id: 'visible-a' }]);
    expect(result.error).toContain('labels unavailable');
  });
});
