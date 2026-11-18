jest.mock('@masarx/api', () => ({ createUiClient: jest.fn() }));
jest.mock('../../packages/ui/src/i18n', () => ({
  createUiTranslator: () => (key: string) => jest.requireActual('../../packages/config/messages/en.json').ui.organizationProfile[key],
}));
jest.mock('../../packages/ui/src/url-guard', () => ({ resolveTrustedExternalDataUrl: (url: string) => url.startsWith('https://trusted.example/') ? url : null }));

import * as React from 'react';
import { createUiClient } from '@masarx/api';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OrganizationProfileForm } from '../../packages/ui/src/organization-profile-form';

const profile = { id: 'org-a', name: 'Original', timezone: 'UTC', locale: 'en', default_settings: { keep: 'value', branding: { primary_color: '#123456' } } };
const initial = { ok: true, profile, logo: { artifact_id: 'old-artifact', file_name: 'old.png' } };
const read = jest.fn();
const save = jest.fn();
const signedUrl = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  read.mockResolvedValue(initial);
  save.mockResolvedValue({ ...initial, profile: { ...profile, name: 'Confirmed by server' } });
  signedUrl.mockResolvedValue({ ok: true, signed_url: 'https://trusted.example/private?token=short' });
  (createUiClient as jest.Mock).mockReturnValue({ organizationProfile: { read, save, signedUrl } });
});

function serializeSelectedLogo(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
  expect(input.files?.[0]).toBe(file);
  const form = input.form!;
  const data = new FormData(form);
  // fireEvent shadows the wrapper's files, not jsdom's internal FileList used by FormData.
  // Model the browser's actual serialized File; validation and mutation stay real.
  data.set('logo', file);
  expect(data.get('logo')).toBe(file);
  const constructor = jest.spyOn(window, 'FormData').mockImplementationOnce((source) => {
    expect(source).toBe(form);
    return data;
  });
  return { form, constructor };
}

test('uses native labeled controls and renders the guarded profile readback', async () => {
  render(<OrganizationProfileForm organizationId="org-a" />);
  expect(await screen.findByLabelText('Organization name')).toHaveValue('Original');
  expect(screen.getByLabelText('Primary color (optional, #RRGGBB)')).toHaveValue('#123456');
  expect(screen.getByLabelText('Replace logo (optional)')).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp');
  expect(read).toHaveBeenCalledWith('org-a');
});

test('waits for actual backend readback and suppresses duplicate submits', async () => {
  let finish!: (value: unknown) => void;
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<OrganizationProfileForm organizationId="org-a" />);
  fireEvent.change(await screen.findByLabelText('Organization name'), { target: { value: 'Requested value' } });
  const form = screen.getByTestId('organization-profile-form');
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Organization name')).toBeDisabled();
  expect(screen.queryByText('Saved and confirmed by backend readback.')).toBeNull();
  await act(async () => { finish({ ...initial, profile: { ...profile, name: 'Server value' } }); });
  expect(await screen.findByLabelText('Organization name')).toHaveValue('Server value');
  expect(screen.getByText('Saved and confirmed by backend readback.')).toBeVisible();
});

test('preserves the displayed previous logo and draft after a failed update', async () => {
  save.mockRejectedValue(new Error('registration or commit unconfirmed'));
  render(<OrganizationProfileForm organizationId="org-a" />);
  fireEvent.change(await screen.findByLabelText('Organization name'), { target: { value: 'Draft value' } });
  fireEvent.submit(screen.getByTestId('organization-profile-form'));
  expect(await screen.findByText('Could not confirm the update. Reload before trying again.')).toBeVisible();
  expect(screen.getByText('old.png')).toBeVisible();
  expect(screen.getByLabelText('Organization name')).toHaveValue('Draft value');
  expect(screen.queryByText('Saved and confirmed by backend readback.')).toBeNull();
});

test('sends only explicit profile and branding fields, not unrelated defaults', async () => {
  render(<OrganizationProfileForm organizationId="org-a" />);
  await screen.findByLabelText('Organization name');
  fireEvent.change(screen.getByLabelText('Secondary color (optional, #RRGGBB)'), { target: { value: '#aabbcc' } });
  fireEvent.submit(screen.getByTestId('organization-profile-form'));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ organization_id: 'org-a', name: 'Original', timezone: 'UTC', locale: 'en', primary_color: '#123456', secondary_color: '#aabbcc' }));
  expect(screen.queryByLabelText('Defaults patch (JSON object)')).toBeNull();
});

test.each(['image/svg+xml', 'application/octet-stream'])('rejects unsupported logo MIME %s before mutation', async (type) => {
  render(<OrganizationProfileForm organizationId="org-a" />);
  const input = await screen.findByLabelText<HTMLInputElement>('Replace logo (optional)');
  const selected = serializeSelectedLogo(input, new File(['not a raster'], 'logo.svg', { type }));
  try {
    fireEvent.submit(selected.form);
    expect(await screen.findByText('Choose a PNG, JPEG or WebP file no larger than 5 MiB.')).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  } finally { selected.constructor.mockRestore(); }
});

test('serializes an accepted selected logo into the authenticated save payload', async () => {
  render(<OrganizationProfileForm organizationId="org-a" />);
  const input = await screen.findByLabelText<HTMLInputElement>('Replace logo (optional)');
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';
  const file = new File([Uint8Array.from(atob(base64), (value) => value.charCodeAt(0))], 'logo.png', { type: 'image/png' });
  const selected = serializeSelectedLogo(input, file);
  try {
    fireEvent.submit(selected.form);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-a', file_name: 'logo.png', content_type: 'image/png', file_base64: base64,
    })));
    expect(save).toHaveBeenCalledTimes(1);
  } finally { selected.constructor.mockRestore(); }
});

test('does not expose an editor if the current writer read is denied', async () => {
  read.mockRejectedValue(new Error('42501'));
  render(<OrganizationProfileForm organizationId="org-a" />);
  expect(await screen.findByText('Could not load this profile with your current permissions. Reload to try again.')).toBeVisible();
  expect(screen.queryByTestId('organization-profile-form')).toBeNull();
});

test('authorizes each private preview and refuses untrusted returned URLs', async () => {
  render(<OrganizationProfileForm organizationId="org-a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Get private logo preview' }));
  const link = await screen.findByRole('link', { name: 'Open logo (private link expires after one minute)' });
  expect(link).toHaveAttribute('href', 'https://trusted.example/private?token=short');
  expect(signedUrl).toHaveBeenCalledWith('org-a');
  signedUrl.mockResolvedValueOnce({ ok: true, signed_url: 'javascript:alert(1)' });
  fireEvent.click(screen.getByRole('button', { name: 'Get private logo preview' }));
  await screen.findByText('Could not authorize a private preview. Try again.');
  expect(screen.queryByRole('link')).toBeNull();
});

test('an old organization read cannot populate a newly selected organization', async () => {
  let finish!: (value: unknown) => void;
  read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<OrganizationProfileForm organizationId="org-a" />);
  read.mockResolvedValueOnce({ ...initial, profile: { ...profile, id: 'org-b', name: 'Tenant B' } });
  view.rerender(<OrganizationProfileForm organizationId="org-b" />);
  await waitFor(() => expect(screen.getByLabelText('Organization name')).toHaveValue('Tenant B'));
  await act(async () => { finish(initial); });
  expect(screen.getByLabelText('Organization name')).toHaveValue('Tenant B');
});
