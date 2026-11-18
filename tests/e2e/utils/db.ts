import { Pool } from "pg";
import { resolveDatabaseUrlWithFallback } from "../../../scripts/utils/resolve-db-url";
import { getDatabaseUrl, isStrictE2EEnv } from "./env";

export async function createE2EDatabasePool(label: string) {
  const strict = isStrictE2EEnv();
  const application_name = `e2e:${label.trim() || "db"}`;
  const selectedName =
    process.env.DB_SMOKE_SELECTED_DSN_NAME ||
    process.env.DATABASE_URL_SELECTED_DSN_NAME;
  if (strict || process.env.DATABASE_URL_POOLER || selectedName) {
    const selected = await resolveDatabaseUrlWithFallback({
      env: { ...process.env, DB_SMOKE_SYNC_DB_PASSWORD: "0" },
      candidatePolicy: "shared-lane-safe",
    });
    return { ...selected, pool: new Pool({ connectionString: selected.dsn, application_name }) };
  }

  const dsn = getDatabaseUrl();
  return {
    dsn,
    candidateName: "DATABASE_URL",
    attempts: 0,
    durationMs: 0,
    pool: new Pool({ connectionString: dsn, application_name }),
  };
}
