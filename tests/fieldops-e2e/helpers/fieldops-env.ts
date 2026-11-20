const REQUIRED_FIELDOPS_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

const DATABASE_RUNTIME_ENV = [
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "DATABASE_URL_POOLER",
  "PG_CONN_STRING",
] as const;

function readEnvValue(env: NodeJS.ProcessEnv, key: string) {
  return String(env[key] || "").trim();
}

export function isFieldOpsStrictMode(env: NodeJS.ProcessEnv = process.env) {
  return readEnvValue(env, "STRICT_CORE_ENV").toLowerCase() === "true";
}

export function missingRequiredFieldOpsEnv(env: NodeJS.ProcessEnv = process.env) {
  const missing: string[] = REQUIRED_FIELDOPS_ENV.filter((key) => !readEnvValue(env, key));
  const hasDatabaseRuntime = DATABASE_RUNTIME_ENV.some((key) => readEnvValue(env, key));
  if (!hasDatabaseRuntime) {
    missing.push(DATABASE_RUNTIME_ENV.join("|"));
  }
  if (readEnvValue(env, "DEMO_ACCOUNTS_PROVISION_GUARD").toLowerCase() !== "enabled") {
    missing.push("DEMO_ACCOUNTS_PROVISION_GUARD=enabled");
  }
  return missing;
}

export function assertFieldOpsEnvForStrictMode(
  label: string,
  missingEnv: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isFieldOpsStrictMode(env) || missingEnv.length === 0) return;

  throw new Error(
    [
      `[fieldops-strict] ${label}: required FieldOps browser-harness environment is missing.`,
      `Missing: ${missingEnv.join(", ")}`,
      "Strict FieldOps gates must fail closed instead of reporting skipped required specs.",
    ].join("\n"),
  );
}
