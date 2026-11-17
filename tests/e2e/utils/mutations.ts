import { isTruthy } from "./env";

type AssertE2EMutationsAllowedParams = {
  label: string;
  details?: string;
};

const ALLOWED_MUTATION_ENVS = new Set(["preview", "dedicated"]);

function isStrictSharedEnv() {
  return isTruthy(process.env.STRICT_E2E_GATE_ENV) || isTruthy(process.env.CI);
}

function formatMissingValue(value: string) {
  return value ? JSON.stringify(value) : "<missing>";
}

export function assertE2EMutationsAllowed(params: AssertE2EMutationsAllowedParams) {
  const { label, details } = params;
  if (!isStrictSharedEnv()) return;

  if (!isTruthy(process.env.E2E_ALLOW_MUTATIONS)) {
    const suffix = details ? ` ${details.trim()}` : "";
    throw new Error(
      [
        `[e2e-mutations] ${label}: persistent mutations are disabled in strict/shared E2E runs.${suffix}`,
        "To enable mutations in an isolated environment, set:",
        "- E2E_ALLOW_MUTATIONS=1",
        "- E2E_MUTATION_ENV=preview (or dedicated)",
      ].join("\n")
    );
  }

  const mutationEnv = String(process.env.E2E_MUTATION_ENV ?? "").trim().toLowerCase();
  if (!ALLOWED_MUTATION_ENVS.has(mutationEnv)) {
    throw new Error(
      [
        `[e2e-mutations] ${label}: E2E_ALLOW_MUTATIONS=1 requires E2E_MUTATION_ENV=preview|dedicated in strict/shared runs.`,
        `Received E2E_MUTATION_ENV=${formatMissingValue(mutationEnv)}.`,
      ].join("\n")
    );
  }
}

