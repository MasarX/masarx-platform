import postgres from "npm:postgres@^3.4.5";
import { readEnv } from "./mod.mjs";

export type HotpathMode = "rest_rpc" | "direct_pooler";

type HotpathRpcResult<T> = {
  data: T | null;
  error: Error | null;
  transport: "direct_pooler";
};

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeHotpathMode = (value: unknown): HotpathMode =>
  normalizeString(value)?.toLowerCase() === "direct_pooler" ? "direct_pooler" : "rest_rpc";

const appendSslModeRequire = (dsn: string): string => {
  try {
    const parsed = new URL(dsn);
    if (!parsed.searchParams.has("sslmode")) {
      parsed.searchParams.set("sslmode", "require");
    }
    return parsed.toString();
  } catch {
    if (/\bsslmode=/i.test(dsn)) return dsn;
    return `${dsn}${dsn.includes("?") ? "&" : "?"}sslmode=require`;
  }
};

const buildPoolerDsnFromEnv = (): string | null => {
  const projectRef = normalizeString(readEnv("SUPABASE_PROJECT_ID", []));
  const password = normalizeString(readEnv("SUPABASE_DB_PASSWORD", []));
  const host = normalizeString(readEnv("SUPABASE_POOLER_HOST", []));
  const port = normalizeString(readEnv("SUPABASE_POOLER_PORT", [])) ?? "5432";
  if (!projectRef || !password || !host) return null;
  const dsn = new URL("postgresql:");
  dsn.username = `postgres.${projectRef}`;
  dsn.password = password;
  dsn.hostname = host;
  dsn.port = port;
  dsn.pathname = "/postgres";
  return appendSslModeRequire(dsn.toString());
};

const resolveHotpathDsn = (): string | null => {
  const explicit = normalizeString(
    readEnv("LABEL_RENDERER_DB_HOTPATH_URL", [
      "DATABASE_URL",
      "DATABASE_URL_POOLER",
      "DATABASE_URL_DIRECT",
    ]),
  );
  if (explicit) return appendSslModeRequire(explicit);
  return buildPoolerDsnFromEnv();
};

type HotpathSql = ReturnType<typeof postgres>;

let hotpathSqlPromise: Promise<HotpathSql | null> | null = null;

const createHotpathSql = async (): Promise<HotpathSql | null> => {
  const dsn = resolveHotpathDsn();
  if (!dsn) return null;
  const sql = postgres(dsn, {
    prepare: false,
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    application_name: "label-renderer-hotpath",
    onnotice: () => {},
  });
  try {
    await sql`select 1`;
    return sql;
  } catch (error) {
    try {
      await sql.end({ timeout: 0 });
    } catch {
      // ignore cleanup error; fallback path will take over
    }
    throw error;
  }
};

const getHotpathSql = async (): Promise<HotpathSql | null> => {
  if (!hotpathSqlPromise) {
    hotpathSqlPromise = createHotpathSql().catch((error) => {
      hotpathSqlPromise = null;
      throw error;
    });
  }
  return await hotpathSqlPromise;
};

const wrapError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(typeof error === "string" ? error : "unknown hotpath db error");

const toJsonArg = (value: unknown) => JSON.stringify(value ?? null);

export const hotpathModeEnabled = (value: unknown): boolean => normalizeHotpathMode(value) === "direct_pooler";

export const executeHotpathRpc = async <T = unknown>(
  mode: unknown,
  functionName: string,
  args: Record<string, unknown>,
): Promise<HotpathRpcResult<T>> => {
  if (!hotpathModeEnabled(mode)) {
    return {
      data: null,
      error: new Error("direct hotpath disabled"),
      transport: "direct_pooler",
    };
  }

  try {
    const sql = await getHotpathSql();
    if (!sql) {
      return {
        data: null,
        error: new Error("direct hotpath database credentials unavailable"),
        transport: "direct_pooler",
      };
    }

    switch (functionName) {
      case "resolve_settings_merged": {
        const rows = await sql.unsafe<{ value: T }[]>(
          "select public.resolve_settings_merged($1::text, $2::text, $3::uuid) as value",
          [
            args.p_category ?? null,
            args.p_scope_type ?? null,
            args.p_scope_id ?? null,
          ],
        );
        return { data: rows[0]?.value ?? null, error: null, transport: "direct_pooler" };
      }
      case "request_label_generation_bulk_compact_v1": {
        const rows = await sql.unsafe<{ value: T }[]>(
          "select public.request_label_generation_bulk_compact_v1($1::jsonb, $2::text, $3::uuid, $4::text, $5::text) as value",
          [
            toJsonArg(args.p_shipments),
            args.p_label_type ?? null,
            args.p_requested_by ?? null,
            args.p_requested_source ?? null,
            args.p_job_purpose ?? null,
          ],
        );
        return { data: rows[0]?.value ?? null, error: null, transport: "direct_pooler" };
      }
      case "request_label_generation_target_v1": {
        const rows = await sql.unsafe<{ value: T }[]>(
          "select public.request_label_generation_target_v1($1::text, $2::uuid, $3::text, $4::uuid, $5::text, $6::uuid, $7::text) as value",
          [
            args.p_target_type ?? null,
            args.p_target_id ?? null,
            args.p_label_type ?? null,
            args.p_requested_by ?? null,
            args.p_requested_source ?? null,
            args.p_target_box_id ?? null,
            args.p_job_purpose ?? null,
          ],
        );
        return { data: rows[0]?.value ?? null, error: null, transport: "direct_pooler" };
      }
      case "request_label_generation_target_for_step_v1": {
        const rows = await sql.unsafe<{ value: T }[]>(
          "select public.request_label_generation_target_for_step_v1($1::uuid, $2::text, $3::uuid, $4::text, $5::uuid, $6::text, $7::uuid, $8::text) as value",
          [
            args.p_workflow_run_step_id ?? null,
            args.p_target_type ?? null,
            args.p_target_id ?? null,
            args.p_label_type ?? null,
            args.p_requested_by ?? null,
            args.p_requested_source ?? null,
            args.p_target_box_id ?? null,
            args.p_job_purpose ?? null,
          ],
        );
        return { data: rows[0]?.value ?? null, error: null, transport: "direct_pooler" };
      }
      case "request_label_generation_bulk_compact_for_step_v1": {
        const rows = await sql.unsafe<{ value: T }[]>(
          "select public.request_label_generation_bulk_compact_for_step_v1($1::uuid, $2::jsonb, $3::text, $4::uuid, $5::text, $6::text) as value",
          [
            args.p_workflow_run_step_id ?? null,
            toJsonArg(args.p_shipments),
            args.p_label_type ?? null,
            args.p_requested_by ?? null,
            args.p_requested_source ?? null,
            args.p_job_purpose ?? null,
          ],
        );
        return { data: rows[0]?.value ?? null, error: null, transport: "direct_pooler" };
      }
      case "lease_and_compose_label_payloads_compact": {
        const rows = await sql.unsafe<T[]>(
          "select * from public.lease_and_compose_label_payloads_compact($1::uuid[], $2::int, $3::int)",
          [
            args.p_job_ids ?? [],
            args.p_lease_seconds ?? null,
            args.p_max_jobs ?? null,
          ],
        );
        return { data: rows, error: null, transport: "direct_pooler" };
      }
      case "lease_label_jobs_by_ids_compact": {
        const rows = await sql.unsafe<T[]>(
          "select * from public.lease_label_jobs_by_ids_compact($1::uuid[], $2::int, $3::int)",
          [
            args.p_job_ids ?? [],
            args.p_lease_seconds ?? null,
            args.p_max_jobs ?? null,
          ],
        );
        return { data: rows, error: null, transport: "direct_pooler" };
      }
      case "lease_label_jobs_by_ids": {
        const rows = await sql.unsafe<T[]>(
          "select * from public.lease_label_jobs_by_ids($1::uuid[], $2::int, $3::int)",
          [
            args.p_job_ids ?? [],
            args.p_lease_seconds ?? null,
            args.p_max_jobs ?? null,
          ],
        );
        return { data: rows, error: null, transport: "direct_pooler" };
      }
      case "compose_label_payloads": {
        const rows = await sql.unsafe<T[]>(
          "select * from public.compose_label_payloads($1::uuid[])",
          [args.p_job_ids ?? []],
        );
        return { data: rows, error: null, transport: "direct_pooler" };
      }
      case "get_label_jobs_status": {
        const rows = await sql.unsafe<T[]>(
          "select * from public.get_label_jobs_status($1::uuid[])",
          [args.p_job_ids ?? []],
        );
        return { data: rows, error: null, transport: "direct_pooler" };
      }
      case "complete_label_jobs": {
        const rows = await sql.unsafe<{ value: T }[]>(
          "select public.complete_label_jobs($1::jsonb) as value",
          [toJsonArg(args.p_results)],
        );
        return { data: rows[0]?.value ?? null, error: null, transport: "direct_pooler" };
      }
      default:
        return {
          data: null,
          error: new Error(`unsupported hotpath rpc: ${functionName}`),
          transport: "direct_pooler",
        };
    }
  } catch (error) {
    return {
      data: null,
      error: wrapError(error),
      transport: "direct_pooler",
    };
  }
};
