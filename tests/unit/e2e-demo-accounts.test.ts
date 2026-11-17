const mockSignInWithPassword = jest.fn();
const mockSignOut = jest.fn();
const mockCreateClient = jest.fn();
const mockSpawnSync = jest.fn();
const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const actualFs = jest.requireActual("fs");

jest.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

jest.mock("child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

function configureManifest(password = "EXAMPLE_PASSWORD") {
  const manifestPath = `${process.cwd()}\\tmp\\demo-accounts.json`;
  mockExistsSync.mockImplementation((target: string) => {
    const normalized = String(target || "").replace(/\//g, "\\").toLowerCase();
    return normalized.endsWith("\\tmp\\demo-accounts.json");
  });
  mockReadFileSync.mockImplementation((target: string, encoding?: string) => {
    const normalized = String(target || "").replace(/\//g, "\\").toLowerCase();
    if (normalized.endsWith("\\tmp\\demo-accounts.json")) {
      return JSON.stringify({
        mode: "persistent",
        password,
        users: [{ email: "lpnoiwlvqmryinlkzgwwiosw@example.invalid", scope_type: "platform" }],
      });
    }
    return actualFs.readFileSync(target, encoding as BufferEncoding | undefined);
  });
  return manifestPath;
}

async function loadDemoAccountsModule() {
  jest.resetModules();
  jest.doMock("../e2e/utils/env", () => ({
    loadE2EEnv: jest.fn(),
    getSupabaseUrl: () => "http://127.0.0.1:54321",
    getSupabaseAnonKey: () => "anon-key",
    getSupabaseDbSchema: () => "api",
  }));
  return require("../e2e/utils/demo-accounts");
}

describe("e2e demo account password resolution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      DEMO_PASSWORD: "EXAMPLE_PASSWORD",
    };
    mockCreateClient.mockReset();
    mockSignInWithPassword.mockReset();
    mockSignOut.mockReset().mockResolvedValue(undefined);
    mockSpawnSync.mockReset();
    mockExistsSync.mockReset();
    mockReadFileSync.mockReset();
    mockCreateClient.mockImplementation(() => ({
      auth: {
        signInWithPassword: mockSignInWithPassword,
        signOut: mockSignOut,
      },
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("does not reprovision demo accounts on transient auth failures", async () => {
    configureManifest("EXAMPLE_PASSWORD");
    mockSignInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { message: "fetch failed", code: "ECONNRESET", status: 503 },
    });

    const { resolveUsableDemoPassword } = await loadDemoAccountsModule();

    await expect(
      resolveUsableDemoPassword({
        email: "lpnoiwlvqmryinlkzgwwiosw@example.invalid",
        password: "EXAMPLE_PASSWORD",
      }),
    ).rejects.toThrow(/fetch failed/i);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  test("reprovisions demo accounts only after explicit invalid-credential failures", async () => {
    configureManifest("EXAMPLE_PASSWORD");
    mockSignInWithPassword
      .mockResolvedValueOnce({
        data: { session: null },
        error: {
          message: "Invalid login credentials",
          code: "invalid_credentials",
          status: 400,
        },
      })
      .mockResolvedValueOnce({
        data: {
          session: { access_token: "token" },
        },
        error: null,
      });
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });

    const { resolveUsableDemoPassword } = await loadDemoAccountsModule();

    await expect(
      resolveUsableDemoPassword({
        email: "lpnoiwlvqmryinlkzgwwiosw@example.invalid",
        password: "EXAMPLE_PASSWORD",
      }),
    ).resolves.toBe("EXAMPLE_PASSWORD");
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });
});
