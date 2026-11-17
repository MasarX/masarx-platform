import {
  DEFAULT_LOCAL_DEMO_PASSWORD,
  buildDemoPasswordCandidates,
  pickDemoRecoveryPassword,
} from "../../../tests/e2e/utils/demo-accounts";

describe("demo account helpers", () => {
  it("builds deduplicated demo password candidates with the stable local fallback", () => {
    expect(
      buildDemoPasswordCandidates({
        cachedPassword: "same",
        requestedPassword: "same",
        envPassword: "env-pass",
        manifestPassword: "",
      }),
    ).toEqual(["same", "env-pass", DEFAULT_LOCAL_DEMO_PASSWORD]);
  });

  it("prefers an explicit environment password for demo account recovery", () => {
    expect(
      pickDemoRecoveryPassword({
        requestedPassword: "requested-pass",
        envPassword: "env-pass",
        manifestPassword: "manifest-pass",
      }),
    ).toBe("env-pass");
  });

  it("falls back to the stable local password when no other recovery candidate exists", () => {
    expect(pickDemoRecoveryPassword({})).toBe(DEFAULT_LOCAL_DEMO_PASSWORD);
  });
});
