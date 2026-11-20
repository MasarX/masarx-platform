import fs from "node:fs";
import path from "node:path";

import { createE2EDatabasePool } from "./db";
import { loadE2EEnv } from "./env";

type DemoManifestUser = {
  email?: string;
  auth_user_id?: string | null;
};

type DemoManifest = {
  organization?: { id?: string; slug?: string; name?: string };
  clients?: Array<{ id?: string; slug?: string; name?: string }>;
  senders?: Array<{ id?: string; sender_name?: string; client_slug?: string }>;
  users?: DemoManifestUser[];
};

type DemoBusinessDataOptions = {
  label: string;
  manifestPath?: string;
  clientSlug: string;
  senderName: string;
  requiredEmails?: string[];
};

type DemoBusinessDataManifest = {
  manifestPath: string;
  manifest: DemoManifest;
};

function resolveManifestPath(manifestPath?: string) {
  const configured = String(manifestPath || process.env.DEMO_ACCOUNTS_PATH || "").trim();
  return path.resolve(process.cwd(), configured || path.join("tmp", "demo-accounts.json"));
}

function readManifest(manifestPath?: string): DemoBusinessDataManifest {
  const resolvedPath = resolveManifestPath(manifestPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Demo manifest not found at ${resolvedPath}`);
  }
  return {
    manifestPath: resolvedPath,
    manifest: JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as DemoManifest,
  };
}

function requireValue(value: string | null | undefined, label: string) {
  const resolved = String(value || "").trim();
  if (!resolved) {
    throw new Error(`Missing required ${label}`);
  }
  return resolved;
}

async function collectMissingBusinessData(
  manifest: DemoManifest,
  options: DemoBusinessDataOptions,
) {
  const organizationId = requireValue(manifest.organization?.id, "demo organization.id");
  const clientSlug = requireValue(options.clientSlug, "demo client slug");
  const senderName = requireValue(options.senderName, "demo sender name");
  const clientId = requireValue(
    manifest.clients?.find((entry) => entry?.slug === clientSlug)?.id,
    `demo client ${clientSlug}`,
  );
  const senderId = requireValue(
    manifest.senders?.find(
      (entry) => entry?.client_slug === clientSlug && entry?.sender_name === senderName,
    )?.id,
    `demo sender ${senderName}`,
  );
  const expectedEmails = Array.from(
    new Set(
      (options.requiredEmails ?? [])
        .concat(
          (manifest.users ?? [])
            .map((user) => String(user?.email || "").trim().toLowerCase())
            .filter(Boolean),
        )
        .map((email) => String(email || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  loadE2EEnv();
  const { pool } = await createE2EDatabasePool(options.label);
  try {
    const [organizationRow, clientRow, senderRow, userRows] = await Promise.all([
      pool.query<{ id: string }>(
        `SELECT id
           FROM public.organizations
          WHERE id = $1::uuid
          LIMIT 1`,
        [organizationId],
      ),
      pool.query<{ id: string; name: string | null }>(
        `SELECT id, name
           FROM public.clients
          WHERE id = $1::uuid AND organization_id = $2::uuid
          LIMIT 1`,
        [clientId, organizationId],
      ),
      pool.query<{ id: string }>(
        `SELECT id
           FROM public.senders
          WHERE id = $1::uuid AND client_id = $2::uuid
          LIMIT 1`,
        [senderId, clientId],
      ),
      expectedEmails.length > 0
        ? pool.query<{ email: string }>(
            `SELECT lower(email) AS email
               FROM public.users
              WHERE lower(email) = ANY($1::text[])`,
            [expectedEmails],
          )
        : Promise.resolve({ rows: [] } as { rows: Array<{ email: string }> }),
    ]);

    const missing: string[] = [];
    if (!organizationRow.rows[0]?.id) missing.push(`organization:${organizationId}`);
    if (!clientRow.rows[0]?.id) missing.push(`client:${clientSlug}`);
    if (!String(clientRow.rows[0]?.name || "").trim()) missing.push(`client-name:${clientSlug}`);
    if (!senderRow.rows[0]?.id) missing.push(`sender:${clientSlug}::${senderName}`);

    const foundEmails = new Set(
      (userRows.rows ?? [])
        .map((row) => String(row.email || "").trim().toLowerCase())
        .filter(Boolean),
    );
    for (const email of expectedEmails) {
      if (!foundEmails.has(email)) missing.push(`user:${email}`);
    }

    return missing;
  } finally {
    await pool.end();
  }
}

export async function ensureDemoBusinessData(options: DemoBusinessDataOptions) {
  const resolved = readManifest(options.manifestPath);
  const missing = await collectMissingBusinessData(resolved.manifest, options);
  if (missing.length > 0) {
    throw new Error(`Demo fixtures are incomplete: ${missing.join(", ")}`);
  }
  return resolved;
}
