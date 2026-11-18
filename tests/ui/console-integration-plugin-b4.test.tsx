import React from 'react';

const listResource = jest.fn();
const me = jest.fn();
const getSession = jest.fn();
const notFound = jest.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

jest.mock('@masarx/api/server', () => ({
  createUiServerClient: jest.fn(() => ({ listResource, me })),
}));

jest.mock('@masarx/auth', () => ({
  createServerClient: jest.fn(() => ({ auth: { getSession } })),
}));

jest.mock('@masarx/ui', () => ({
  ...jest.requireActual('../../packages/ui/src/url-guard'),
  LoadingState: () => null,
  MappingStudioPage: () => null,
  hasCapability: (capabilities: Set<string>, capability: string) => capabilities.has(capability),
  resolveCapabilitySet: (capabilities: string[]) => new Set(capabilities),
}));

jest.mock('next/dynamic', () => () => function DynamicMappingStudio() {
  return null;
});

jest.mock('next/navigation', () => ({ notFound }));

jest.mock('../../apps/console/app/app-context', () => ({
  withConsoleConfig:
    (render: (context: { appKey: string; appBasePath: string }, props: any) => unknown) =>
    async (props: any) => render({ appKey: 'console', appBasePath: '/console' }, {
      ...props, params: await props.params, searchParams: await props.searchParams,
    }),
}));

jest.mock('../../apps/console/app/_components/resource-page', () => ({
  ResourcePage: () => null,
}));

import ConsoleIntegrationPluginVersionPage from '../../apps/console/app/integrations/plugins/[plugin_id]/versions/[version]/page';
import ConsoleIntegrationPluginNewPage from '../../apps/console/app/integrations/plugins/new/page';

describe('B4 Console integration plugin routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a numeric plugin version to its canonical detail id', async () => {
    const detailId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
    listResource.mockResolvedValue({ items: [{ id: detailId }] });

    const node = await ConsoleIntegrationPluginVersionPage({
      params: Promise.resolve({ plugin_id: 'plugin-1', version: '7' }),
      searchParams: Promise.resolve({}),
    }) as React.ReactElement;

    expect(listResource).toHaveBeenCalledWith(
      'integration_plugin_versions',
      { plugin_id: 'plugin-1', version_no: 7 },
      2,
      0,
      null,
    );
    expect(node.props.searchParams).toEqual(expect.objectContaining({
      id: detailId,
      detail_open: '1',
      plugin_id: 'plugin-1',
      version_no: '7',
    }));
  });

  it('fails closed when an authenticated caller lacks plugin write capability', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
    me.mockResolvedValue({ capabilities: ['integration_plugins.read'] });

    await expect(ConsoleIntegrationPluginNewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(me).toHaveBeenCalledTimes(1);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
