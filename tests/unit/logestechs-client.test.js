const { baseUrl } = require('../fixtures/carrier/vendor-account.synthetic.json');

jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));

function loadClient(metadata, baseUrlOverride) {
  const env = { ...process.env, DATABASE_URL: 'postgresql://localhost/example' };
  if (baseUrlOverride) env.LOGESTECHS_BASE_URL = baseUrlOverride;
  else delete env.LOGESTECHS_BASE_URL;
  jest.replaceProperty(process, 'env', env);

  const connection = {
    query: jest.fn().mockResolvedValue({
      rows: [{ provider_id: 'provider-fixture', metadata, credentials: { username: 'test', password: 'test' } }],
    }),
    release: jest.fn(),
  };
  const on = jest.spyOn(process, 'on').mockReturnValue(process);
  let client;
  try {
    jest.isolateModules(() => {
      require('pg').Pool.mockImplementation(() => ({ connect: async () => connection }));
      client = require('../../scripts/clients/logestechs');
    });
  } finally {
    on.mockRestore();
  }
  return { client, connection };
}

afterEach(() => jest.restoreAllMocks());

test('reads the base URL from provider metadata', async () => {
  const { client } = loadClient({ base_url: baseUrl });

  await expect(client.getConfig()).resolves.toMatchObject({ baseUrl });
});

test('lets the environment override provider metadata', async () => {
  const override = 'https://override.example.invalid';
  const { client } = loadClient({ base_url: baseUrl }, ` ${override}/ `);

  await expect(client.getConfig()).resolves.toMatchObject({ baseUrl: override });
});

test('reports missing base URL configuration and releases the database connection', async () => {
  const { client, connection } = loadClient({ base_url: ' ' });

  await expect(client.getConfig()).rejects.toThrow('Set LOGESTECHS_BASE_URL or configure providers.metadata.base_url.');
  expect(connection.release).toHaveBeenCalledTimes(1);
});
