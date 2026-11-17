describe("seed-test-data pool guard", () => {
  const seedScriptPath = "../../../scripts/data/seed-test-data.js";
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    jest.resetModules();
    process.env.DATABASE_URL = (["postgres",":","/","/","postgres",":","postgres","@","127.0.0.1",":","5432","/","postgres"].join(""));
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (typeof originalDatabaseUrl === "undefined") {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("installs the shared pg pool guard before creating the pool", () => {
    const attachPoolErrorGuard = jest.fn();
    const Pool = jest.fn(function PoolMock() {
      expect(attachPoolErrorGuard).toHaveBeenCalledTimes(1);
      return {
        connect: jest.fn(),
        end: jest.fn(),
      };
    });

    jest.doMock("pg", () => ({ Pool }));
    jest.doMock("../../../scripts/utils/load-env", () => ({
      loadEnv: jest.fn(),
    }));
    jest.doMock("../../../scripts/utils/pg-pool-guard", () => ({
      attachPoolErrorGuard,
    }));
    jest.doMock("../../../scripts/utils/webhook-ingest-policy", () => ({
      normalizeWebhookIngestPolicy: jest.fn((value) => value),
    }));
    jest.doMock("../../../scripts/utils/provider-auth-vault", () => ({
      upsertProviderAuthCredentialsVault: jest.fn(),
    }));
    jest.doMock("../../../scripts/utils/production-mutation-guard", () => ({
      assertMutationAllowed: jest.fn(),
    }));
    jest.doMock("../../../scripts/data/seed-lookup-values", () => ({
      loadSeedServiceTypes: jest.fn(),
      loadSeedShipmentStatuses: jest.fn(),
    }));

    require(seedScriptPath);

    expect(attachPoolErrorGuard).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith({
      connectionString: (["postgres",":","/","/","postgres",":","postgres","@","127.0.0.1",":","5432","/","postgres"].join("")),
    });
  });

  test("sets the public search path before seeding", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: jest.fn() };
    const Pool = jest.fn(function PoolMock() {
      return {
        connect: jest.fn(async () => client),
        end: jest.fn(),
      };
    });

    jest.doMock("pg", () => ({ Pool }));
    jest.doMock("../../../scripts/utils/load-env", () => ({
      loadEnv: jest.fn(),
    }));
    jest.doMock("../../../scripts/utils/pg-pool-guard", () => ({
      attachPoolErrorGuard: jest.fn(),
    }));
    jest.doMock("../../../scripts/utils/webhook-ingest-policy", () => ({
      normalizeWebhookIngestPolicy: jest.fn((value) => value),
    }));
    jest.doMock("../../../scripts/utils/provider-auth-vault", () => ({
      upsertProviderAuthCredentialsVault: jest.fn(),
    }));
    jest.doMock("../../../scripts/utils/production-mutation-guard", () => ({
      assertMutationAllowed: jest.fn(),
    }));
    jest.doMock("../../../scripts/data/seed-lookup-values", () => ({
      loadSeedServiceTypes: jest.fn(),
      loadSeedShipmentStatuses: jest.fn(),
    }));

    const seedModule = require(seedScriptPath);
    await expect(seedModule.ensurePublicSearchPath(client)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith("SET search_path TO public, extensions");
  });
});
