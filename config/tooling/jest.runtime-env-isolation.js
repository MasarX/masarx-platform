const runnerMutationEnvKeys = [
  'GITHUB_ENV',
  'GITHUB_OUTPUT',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY',
  'MASARX_RUNTIME_LEASE_DIR',
];

beforeEach(() => {
  for (const key of runnerMutationEnvKeys) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of runnerMutationEnvKeys) {
    delete process.env[key];
  }
});
