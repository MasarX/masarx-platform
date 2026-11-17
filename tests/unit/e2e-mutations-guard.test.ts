import { assertE2EMutationsAllowed } from "../e2e/utils/mutations";

const ENV_KEYS = [
  "CI",
  "STRICT_E2E_GATE_ENV",
  "E2E_ALLOW_MUTATIONS",
  "E2E_MUTATION_ENV",
] as const;

function unset(keys: readonly string[]) {
  for (const key of keys) {
    delete process.env[key];
  }
}

describe("assertE2EMutationsAllowed", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Keep unit tests hermetic: only mutate the keys we care about.
    unset(ENV_KEYS);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("allows mutations when not in strict/shared env", () => {
    expect(() => assertE2EMutationsAllowed({ label: "seed" })).not.toThrow();
  });

  it("denies mutations in strict env by default", () => {
    process.env.CI = "true";
    expect(() => assertE2EMutationsAllowed({ label: "seed" })).toThrow(
      /persistent mutations are disabled/i
    );
  });

  it("requires E2E_MUTATION_ENV when E2E_ALLOW_MUTATIONS=1 in strict env", () => {
    process.env.CI = "1";
    process.env.E2E_ALLOW_MUTATIONS = "1";
    expect(() =>
      assertE2EMutationsAllowed({ label: "seed" })
    ).toThrow(/E2E_MUTATION_ENV/i);
  });

  it("allows mutations in strict env when explicitly enabled for preview", () => {
    process.env.CI = "1";
    process.env.E2E_ALLOW_MUTATIONS = "1";
    process.env.E2E_MUTATION_ENV = "preview";
    expect(() => assertE2EMutationsAllowed({ label: "seed" })).not.toThrow();
  });

  it("allows mutations in strict env when explicitly enabled for dedicated", () => {
    process.env.CI = "1";
    process.env.E2E_ALLOW_MUTATIONS = "1";
    process.env.E2E_MUTATION_ENV = "dedicated";
    expect(() => assertE2EMutationsAllowed({ label: "seed" })).not.toThrow();
  });

  it("rejects unknown mutation env values", () => {
    process.env.CI = "1";
    process.env.E2E_ALLOW_MUTATIONS = "1";
    process.env.E2E_MUTATION_ENV = "staging";
    expect(() =>
      assertE2EMutationsAllowed({ label: "seed" })
    ).toThrow(/preview\\|dedicated/i);
  });
});
