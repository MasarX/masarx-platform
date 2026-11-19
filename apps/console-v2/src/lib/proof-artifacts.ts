import { getSupabaseClient } from './supabase';

export type ConsoleProofArtifactKind = 'signature' | 'photo';

export interface RegisterConsoleProofArtifactInput {
  file: File;
  artifactKind: ConsoleProofArtifactKind;
  organizationId: string;
  taskId: string;
  routeStopId: string;
  routeRunId: string;
  shipmentId: string;
}

function createConsoleProofArtifactKey(organizationId: string, taskId: string, file: File): string {
  const cleanName = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(-80);
  const extension = cleanName.includes('.') ? cleanName.split('.').pop() : 'bin';
  const randomId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${organizationId}/${taskId}/${Date.now()}-${randomId}.${extension || 'bin'}`;
}

export async function registerConsoleProofArtifact(input: RegisterConsoleProofArtifactInput): Promise<string> {
  const client = getSupabaseClient();
  if (!client) throw new Error('Proof upload requires a backend-backed Console session');

  const storageBucket = 'fieldops-evidence';
  const storageKey = createConsoleProofArtifactKey(input.organizationId, input.taskId, input.file);
  const upload = await client.storage.from(storageBucket).upload(storageKey, input.file, {
    contentType: input.file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upload.error) throw upload.error;

  const target = typeof client.schema === 'function' ? client.schema('api') : client;
  const { data, error } = await target.rpc('register_mobile_artifact_v1', {
    p_artifact: {
      organization_id: input.organizationId,
      storage_bucket: storageBucket,
      storage_key: storageKey,
      mime_type: input.file.type || 'application/octet-stream',
      size_bytes: input.file.size,
      source_system: 'console_v2',
      metadata: {
        app: 'console-v2',
        artifact_kind: input.artifactKind,
        proof_use: 'route_stop_closeout',
        task_id: input.taskId,
        route_stop_id: input.routeStopId,
        route_run_id: input.routeRunId,
        shipment_id: input.shipmentId,
        captured_at: new Date().toISOString(),
        original_name: input.file.name,
      },
    },
  });
  if (error) throw error;

  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const artifactId = String((rows[0] as Record<string, unknown> | undefined)?.artifact_id ?? '').trim();
  if (!artifactId) throw new Error('Proof artifact registration did not return an artifact id');
  return artifactId;
}
