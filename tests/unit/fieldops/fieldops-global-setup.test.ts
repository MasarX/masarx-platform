import {
  ensureFieldOpsSignatureMimeSupport,
  ensureFieldOpsSignatureMimeSupportViaDatabase,
  resolveStorageAdminKey,
  resolveStorageAdminKeyCandidates,
} from "../../../tests/fieldops-e2e/helpers/global-setup";

function makePgClient(rows: Array<Record<string, unknown>>) {
  const client = {
    connect: jest.fn(async () => undefined),
    query: jest.fn(async (text: string) => {
      if (/select allowed_mime_types/i.test(text)) {
        return { rows };
      }
      return { rows: [] };
    }),
    end: jest.fn(async () => undefined),
  };
  const ClientImpl = jest.fn(() => client);
  return { ClientImpl, client };
}

describe("fieldops global setup", () => {
  test("prefers JWT-compatible storage admin keys over modern opaque secrets", () => {
    const env = {
      SUPABASE_SECRET_KEY: "sb_secret_fixture",
      SUPABASE_SERVICE_ROLE_KEY: "fixture.primary.signature",
      SERVICE_ROLE_KEY: "fixture.secondary.signature",
    } as NodeJS.ProcessEnv;

    expect(resolveStorageAdminKeyCandidates(env)).toEqual([
      env.SUPABASE_SERVICE_ROLE_KEY,
      env.SERVICE_ROLE_KEY,
    ]);
    expect(resolveStorageAdminKey(env)).toBe(env.SUPABASE_SERVICE_ROLE_KEY);
  });

  test("does not pass opaque Supabase secrets into Storage admin checks", () => {
    const env = {
      SUPABASE_SECRET_KEY: "sb_secret_fixture",
    } as NodeJS.ProcessEnv;

    expect(resolveStorageAdminKeyCandidates(env)).toEqual([]);
    expect(resolveStorageAdminKey(env)).toBe("");
  });

  test("retries JWT-compatible admin key candidates before updating signature MIME support", async () => {
    const firstStorage = {
      getBucket: jest.fn(async () => ({
        data: null,
        error: { message: "Invalid Compact JWS" },
      })),
      updateBucket: jest.fn(),
    };
    const secondStorage = {
      getBucket: jest.fn(async () => ({
        data: {
          public: false,
          file_size_limit: 1024,
          allowed_mime_types: ["image/png"],
        },
        error: null,
      })),
      updateBucket: jest.fn(async () => ({ error: null })),
    };
    const createClientImpl = jest
      .fn()
      .mockReturnValueOnce({ storage: firstStorage })
      .mockReturnValueOnce({ storage: secondStorage });

    await ensureFieldOpsSignatureMimeSupport({
      env: {
        SUPABASE_URL: "https://storage.example.invalid",
        SUPABASE_SERVICE_ROLE_KEY: "fixture.primary.signature",
        SERVICE_ROLE_KEY: "fixture.alternate.signature",
      } as NodeJS.ProcessEnv,
      createClientImpl: createClientImpl as never,
    });

    expect(createClientImpl).toHaveBeenCalledTimes(2);
    expect(secondStorage.updateBucket).toHaveBeenCalledWith("fieldops-evidence", {
      public: false,
      fileSizeLimit: 1024,
      allowedMimeTypes: ["image/png", "image/svg+xml"],
    });
  });

  test("falls back to database bucket metadata when Storage API rejects JWT admin keys", async () => {
    const storage = {
      getBucket: jest.fn(async () => ({
        data: null,
        error: { message: "signature verification failed" },
      })),
      updateBucket: jest.fn(),
    };
    const createClientImpl = jest.fn().mockReturnValue({ storage });
    const { ClientImpl, client } = makePgClient([{ allowed_mime_types: ["image/png"] }]);

    await ensureFieldOpsSignatureMimeSupport({
      env: {
        SUPABASE_URL: "https://storage.example.invalid",
        SUPABASE_SERVICE_ROLE_KEY: "fixture.primary.signature",
        DATABASE_URL_DIRECT: "postgresql://fixture@db.example.invalid:5432/postgres",
      } as NodeJS.ProcessEnv,
      createClientImpl: createClientImpl as never,
      dbClientImpl: ClientImpl as never,
    });

    expect(createClientImpl).toHaveBeenCalledTimes(1);
    expect(ClientImpl).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(
      "UPDATE storage.buckets SET allowed_mime_types = $2 WHERE id = $1 OR name = $1",
      ["fieldops-evidence", ["image/png", "image/svg+xml"]],
    );
  });

  test("reports database fallback failure when Storage API auth and DB metadata both fail", async () => {
    const storage = {
      getBucket: jest.fn(async () => ({
        data: null,
        error: { message: "Invalid JWT" },
      })),
      updateBucket: jest.fn(),
    };
    const createClientImpl = jest.fn().mockReturnValue({ storage });

    await expect(
      ensureFieldOpsSignatureMimeSupport({
        env: {
          SUPABASE_URL: "https://storage.example.invalid",
          SUPABASE_SERVICE_ROLE_KEY: "fixture.primary.signature",
        } as NodeJS.ProcessEnv,
        createClientImpl: createClientImpl as never,
      }),
    ).rejects.toThrow(/DB fallback failed/i);
  });

  test("database fallback accepts existing FieldOps SVG signature MIME support", async () => {
    const { ClientImpl, client } = makePgClient([
      { allowed_mime_types: ["image/png", "image/svg+xml"] },
    ]);

    const result = await ensureFieldOpsSignatureMimeSupportViaDatabase({
      env: {
        DATABASE_URL_DIRECT: "postgresql://fixture@db.example.invalid:5432/postgres",
      } as NodeJS.ProcessEnv,
      ClientImpl: ClientImpl as never,
    });

    expect(result).toMatchObject({ ok: true, candidate: "DATABASE_URL_DIRECT" });
    expect(client.query).not.toHaveBeenCalledWith(
      "UPDATE storage.buckets SET allowed_mime_types = $2 WHERE id = $1 OR name = $1",
      expect.anything(),
    );
  });
});
