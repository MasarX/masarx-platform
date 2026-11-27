const { verifyHostedDatabaseInit } = require('../../../scripts/ci-hosted/backend.cjs');
const { rewrite } = require('../../../scripts/ci-hosted/docker-images.cjs');

const databaseContainer = 'supabase_db_synthetic';
const databasePin = { role: 'database', image: 'supabase/postgres', digest: `sha256:${'a'.repeat(64)}` };
const authPin = { role: 'auth', image: 'supabase/gotrue', digest: `sha256:${'b'.repeat(64)}` };
const pins = [databasePin, authPin];
const config = {
  Image: `${databasePin.image}:17`,
  Healthcheck: { Test: ['CMD', 'pg_isready'], Interval: 10e9, Timeout: 2e9 },
  HostConfig: { Binds: [`${databaseContainer}:/var/lib/postgresql/data`], NetworkMode: 'supabase_network_synthetic' },
};

function create(name, body, initContainer) {
  const url = `/v1.51/containers/create?name=${name}`;
  return JSON.parse(rewrite('POST', url, Buffer.from(JSON.stringify(body)), pins, initContainer).body);
}

test('adds Docker init at creation while preserving the hosted pgTAP probe and container settings', () => {
  expect(create(databaseContainer, config, databaseContainer)).toEqual({
    ...config,
    Image: `public.ecr.aws/${databasePin.image}@${databasePin.digest}`,
    HostConfig: { ...config.HostConfig, Init: true },
  });
});

test('scopes the pgTAP init override to the named database in the opted-in guard', () => {
  expect(create('supabase_db_other', config, databaseContainer).HostConfig).toEqual(config.HostConfig);
  expect(create(databaseContainer, config).HostConfig).toEqual(config.HostConfig);
});

test('denies the hosted pgTAP init override for another reviewed image or an ambiguous host configuration', () => {
  expect(() => create(databaseContainer, { ...config, Image: authPin.image }, databaseContainer))
    .toThrow('Docker init requires the reviewed database image');
  expect(() => create(databaseContainer, { ...config, HostConfig: null }, databaseContainer))
    .toThrow('Invalid Docker HostConfig for database init');
  expect(() => create(databaseContainer, { ...config, hostconfig: {} }, databaseContainer))
    .toThrow('Invalid Docker HostConfig for database init');
  expect(() => create(databaseContainer, { ...config, HostConfig: { init: false } }, databaseContainer))
    .toThrow('Invalid Docker HostConfig for database init');
});

test('reads the hosted pgTAP database PID 1 before the suite can run', async () => {
  const checked = jest.fn().mockResolvedValue('docker-init\n');
  const env = {};
  await expect(verifyHostedDatabaseInit(checked, env, databaseContainer)).resolves.toBe('docker-init');
  expect(checked).toHaveBeenCalledWith('docker', ['exec', databaseContainer, 'cat', '/proc/1/comm'], env, 10000, { quiet: true });
});

test('fails hosted pgTAP startup when the in-container PID 1 is still postgres', async () => {
  await expect(verifyHostedDatabaseInit(jest.fn().mockResolvedValue('postgres\n'), {}, databaseContainer))
    .rejects.toThrow('Hosted database requires docker-init as PID 1');
});
