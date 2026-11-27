// plugin-studio.arabic.test.tsx: the plugin studio page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { PluginStudioModule } from '@/modules/integrations/plugin-studio';
import * as apiMod from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import { englishT, fill } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-plugin-studio';

const AR = ar.integrationsPluginStudio.pluginStudioModule;

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('PluginStudioModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/plugin-studio');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    toastStore.clearToasts();
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<PluginStudioModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsPluginStudio.pluginStudioModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsPluginStudio.pluginStudioModule.guidedIntegrationSetup);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<PluginStudioModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsPluginStudio.pluginStudioModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsPluginStudio.pluginStudioModule.save')).toBe('Save');
    expect(englishT('integrationsPluginStudio.pluginStudioModule.saveWithMode')).toBe('Save ({mode})');
    expect(lookup(ar, 'integrationsPluginStudio.pluginStudioModule.titleAccent')).toMatch(/[؀-ۿ]/);
  });

  it('reports a stage failure without detail in one Arabic sentence', async () => {
    vi.spyOn(apiMod, 'plugin_studio_parse_v1').mockRejectedValue({});
    const user = userEvent.setup();
    renderWithProviders(<PluginStudioModule />, { locale: 'ar', capabilities: ['all'] });

    await user.click(await screen.findByRole('button', { name: AR.parse }));
    const expected = fill(AR.parseFailed, { message: AR.parseFailedNoDetail });
    await waitFor(() => {
      expect(toastStore.getToasts().map((toast) => toast.message)).toContain(expected);
    });
    const box = document.createElement('div');
    box.textContent = toastStore.getToasts().map((toast) => toast.message).join(' ');
    expect(findUntranslated(box)).toEqual([]);
    expect(findUntranslated(screen.getByTestId('plugin-studio-error'))).toEqual([]);
  });

  it('keeps one whole sentence per blocked and failed stage in both languages', () => {
    // The blocked toasts only fire when a disabled stage button is reached, so their copy is checked here.
    const box = document.createElement('div');
    box.textContent = [
      AR.parseBlocked,
      AR.inferBlocked,
      AR.previewBlocked,
      AR.saveBlocked,
      AR.inferFailedNoDetail,
      AR.previewFailedNoDetail,
      AR.saveFailedNoDetail,
      AR.savedPluginIdMissing,
    ].join(' ');
    expect(findUntranslated(box)).toEqual([]);
    expect(englishT('integrationsPluginStudio.pluginStudioModule.parseBlocked')).toBe('Parse blocked · live backend is not configured');
    expect(englishT('integrationsPluginStudio.pluginStudioModule.saveBlocked')).toBe('Save blocked · live backend is not configured');
    expect(englishT('integrationsPluginStudio.pluginStudioModule.parseFailedNoDetail')).toBe('parse failed');
  });
});
