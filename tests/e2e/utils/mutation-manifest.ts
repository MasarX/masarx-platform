import fs from "fs";
import path from "path";

export type MutationManifestEntry = {
  kind: "settings_view" | "shipment" | "task" | "workflow_template" | "unknown";
  id: string;
  label: string;
  metadata?: Record<string, unknown> | null;
};

type MutationManifestRecord = MutationManifestEntry & {
  run_id: string | null;
  captured_at: string;
};

function resolveManifestPath() {
  const configured = String(process.env.E2E_MUTATION_MANIFEST_PATH ?? "").trim();
  return configured || "";
}

export function appendMutationManifestEntry(entry: MutationManifestEntry) {
  const manifestPath = resolveManifestPath();
  if (!manifestPath) return false;

  const resolvedPath = path.resolve(process.cwd(), manifestPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const runId = String(process.env.E2E_A2Z_RUN_ID ?? "").trim() || null;
  const record: MutationManifestRecord = {
    ...entry,
    run_id: runId,
    captured_at: new Date().toISOString(),
  };

  fs.appendFileSync(resolvedPath, `${JSON.stringify(record)}\n`, "utf8");
  return true;
}

