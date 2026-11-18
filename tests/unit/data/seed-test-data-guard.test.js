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

  test("marks only the seed organization upsert window with the demo provisioning source", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ source: "previous-source" }] })
      .mockResolvedValue({ rows: [] });
    const action = jest.fn().mockResolvedValue("seed-org-id");
    const Pool = jest.fn(function PoolMock() {
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
    await expect(
      seedModule.withOrganizationOnboardingSource(
        { query },
        seedModule.SEED_DATA_ONBOARDING_SOURCE,
        action,
      ),
    ).resolves.toBe("seed-org-id");

    expect(action).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT current_setting('app.organization_onboarding_source', true) AS source",
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('app.organization_onboarding_source', $1, false)",
      [seedModule.SEED_DATA_ONBOARDING_SOURCE],
    );
    expect(query).toHaveBeenLastCalledWith(
      "SELECT set_config('app.organization_onboarding_source', $1, false)",
      ["previous-source"],
    );
  });

  test("runs canonical onboarding bootstrap after seed clients and senders exist", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ result: { ok: true, organization_id: "org-1" } }] })
      .mockResolvedValueOnce({ rows: [{ result: { ok: true, organization_id: "org-2" } }] });
    const Pool = jest.fn(function PoolMock() {
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
    await expect(
      seedModule.runSeedTenantOnboardingBootstrap({ query }, ["org-1", "org-2"]),
    ).resolves.toEqual([
      { ok: true, organization_id: "org-1" },
      { ok: true, organization_id: "org-2" },
    ]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("public.bootstrap_tenant_onboarding_v1"),
      ["org-1", seedModule.SEED_DATA_POST_PROVISION_BOOTSTRAP_SOURCE],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("public.bootstrap_tenant_onboarding_v1"),
      ["org-2", seedModule.SEED_DATA_POST_PROVISION_BOOTSTRAP_SOURCE],
    );
  });

  test("fails closed when canonical seed onboarding bootstrap reports not ok", async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ result: { ok: false, error: { code: "blocked" } } }],
    });
    const Pool = jest.fn(function PoolMock() {
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
    await expect(
      seedModule.runSeedTenantOnboardingBootstrap({ query }, ["org-1"]),
    ).rejects.toThrow("Tenant onboarding bootstrap failed for seed organization org-1");
  });
});
