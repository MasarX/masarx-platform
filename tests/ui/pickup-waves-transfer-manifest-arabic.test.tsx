import * as React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { unwrapMessagesImport } from '@masarx/config';
import * as enRaw from '../../packages/config/messages/en.json';
import * as arRaw from '../../packages/config/messages/ar.json';
import * as consoleArRaw from '../../apps/console/messages/ar.json';
import { PickupWavesPage } from '../../packages/ui/src/pickup-waves-page';
import { WarehouseTransferManifestCreateForm } from '../../packages/ui/src/warehouse-transfer-manifest-create-form';
import { renderWithIntl } from './test-utils';

type Messages = Record<string, unknown>;
type MessagesImport = Messages | { default: Messages };
type Tree = { [key: string]: string | Tree };
const en = unwrapMessagesImport(enRaw as MessagesImport) as { ui: Record<string, Tree> };
const ar = unwrapMessagesImport(arRaw as MessagesImport) as { ui: Record<string, Tree> };
const arMessages = { ...ar, ...unwrapMessagesImport(consoleArRaw as MessagesImport) };
const uiRpc = jest.fn();
const readRpc = jest.fn();

jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@masarx/api/server', () => ({ createUiServerClient: () => ({
  me: async () => ({ org: { id: 'org-a' }, capabilities: ['fleet.write'] }), rpc: uiRpc,
}) }));
jest.mock('@masarx/auth/server', () => ({ createServerClient: () => ({ rpc: readRpc }) }));
jest.mock('../../packages/ui/src/use-unsaved-changes', () => ({ useUnsavedChangesGuard: () => undefined }));

const leaves = (tree: Tree): string[] =>
  Object.values(tree).flatMap((value) => (typeof value === 'string' ? [value] : leaves(value)));

// Every English catalog string without ICU arguments must be absent from text, placeholders and labels.
function expectNoEnglish(container: HTMLElement, namespaces: string[]) {
  const attributes = Array.from(container.querySelectorAll('[placeholder],[aria-label],[title]'))
    .flatMap((element) => ['placeholder', 'aria-label', 'title'].map((name) => element.getAttribute(name) ?? ''));
  const rendered = [container.textContent ?? '', ...attributes].join('\n');
  const english = namespaces.flatMap((ns) => leaves(en.ui[ns])).filter((value) => !value.includes('{'));
  expect(english.filter((value) => rendered.includes(value))).toEqual([]);
}

async function inArabic(run: () => Promise<void>) {
  const originalLocale = process.env.NEXT_PUBLIC_LOCALE;
  process.env.NEXT_PUBLIC_LOCALE = 'ar';
  try {
    await run();
  } finally {
    if (originalLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = originalLocale;
  }
}

const waves = ar.ui.pickupWaves as Tree & { ledger: Tree; fields: Tree };
const manifest = ar.ui.transferManifestCreate as Tree & { form: Tree; errors: Tree };

test('Arabic pickup waves page takes every string from the Arabic catalog', () => inArabic(async () => {
  const routeRunId = '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e';
  readRpc.mockImplementation(async (name: string) => ({ data: name === 'pickup_waves_list_v1'
    ? [{ route_run_id: routeRunId, organization_id: 'org-a', shipments: [] }] : [], error: null }));
  uiRpc.mockImplementation(async (name: string) => name === 'pickup_assignment_options_v1'
    ? { branches: [], drivers: [], vehicles: [], partners: [] } : {});
  const view = renderWithIntl(
    await PickupWavesPage({ appKey: 'console', appBasePath: '/console', searchParams: {}, testIdPrefix: 'pickup' }),
    { locale: 'ar', messages: arMessages },
  );
  expect(screen.getAllByText(waves.title as string).length).toBeGreaterThan(0);
  expect(screen.getByText(waves.ledger.title as string)).toBeInTheDocument();
  expect(screen.getByText(waves.ledger.noWindow as string)).toBeInTheDocument();
  expectNoEnglish(view.container, ['pickupWaves', 'pickupOperations']);
  view.unmount();
}));

test('Arabic transfer manifest form shows Arabic labels and validation errors', () => inArabic(async () => {
  const user = userEvent.setup();
  const view = renderWithIntl(
    <WarehouseTransferManifestCreateForm appBasePath="/console" organizationId="org-1"
      accessScope={{ scope_type: 'tenant', scope_id: 'tenant-1' }} capabilities={['warehouse_transfers.write']}
      capabilityWrite="warehouse_transfers.write" testIdPrefix="manifest" />,
    { locale: 'ar', messages: arMessages },
  );
  await user.click(screen.getByTestId('manifest-submit'));
  expect(await screen.findByTestId('manifest-error')).toHaveTextContent(manifest.errors.transferCodeRequired as string);
  expectNoEnglish(view.container, ['transferManifestCreate']);

  await user.type(screen.getByTestId('manifest-transfer-code'), 'XFER-001');
  await user.type(screen.getByTestId('manifest-from-branch-id'), 'branch-from');
  await user.type(screen.getByTestId('manifest-to-branch-id'), 'branch-to');
  await user.type(screen.getByTestId('manifest-shipment-ids'), 'ship-1');
  await user.type(screen.getByTestId('manifest-planned-dispatch-at'), 'tomorrow');
  await user.click(screen.getByTestId('manifest-submit'));
  expect(await screen.findByTestId('manifest-error')).toHaveTextContent(manifest.errors.invalidDispatch as string);
  expectNoEnglish(view.container, ['transferManifestCreate']);
  view.unmount();
}));
