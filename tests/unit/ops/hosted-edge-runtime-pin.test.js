const pins = require('../../../config/ci/hosted-integration-images.json');
const { services } = require('../../fixtures/ci/supabase-services-2.116.0.json');
const { prepareImages } = require('../../../scripts/ci-hosted/images.cjs');
const { rewrite } = require('../../../scripts/ci-hosted/docker-images.cjs');

test('hosted CI uses an Edge image with the SQLite cache fix even when the CLI requests its older tag', async () => {
  const pin = { ...pins.find(({ role }) => role === 'edge-runtime') };
  const cliTag = services.find(({ name }) => name === pin.image).local;
  const cliImage = `public.ecr.aws/${pin.image}:${cliTag}`;
  const pinnedImage = `${pin.mirror}/${pin.image}@${pin.digest}`;
  const checked = jest.fn(async (_command, [operation, subcommand]) =>
    operation === 'image' && subcommand === 'inspect' ? pin.image_id : '');

  expect(pin.tag).toMatch(/^v\d+\.\d+\.\d+$/);
  expect(pin.tag.localeCompare('v1.77.1', 'en', { numeric: true })).toBeGreaterThanOrEqual(0);
  await prepareImages([pin], { checked, timed: (_label, action) => action(), summary: {}, quiet: true });

  expect(checked).toHaveBeenCalledWith('docker', ['pull', '--platform', 'linux/amd64', pinnedImage], undefined, expect.any(Object));
  expect(checked).toHaveBeenCalledWith('docker', ['tag', pin.image_id, cliImage], undefined, expect.any(Number));
  const request = rewrite('POST', '/containers/create', Buffer.from(JSON.stringify({ Image: cliImage })), [pin]);
  expect(JSON.parse(request.body).Image).toBe(pin.image_id);
});
