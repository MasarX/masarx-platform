import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMocks = vi.hoisted(() => {
  const upload = vi.fn();
  const rpc = vi.fn();
  const schema = vi.fn(() => ({ rpc }));
  const from = vi.fn(() => ({ upload }));
  return { from, rpc, schema, upload, getSupabaseClient: vi.fn() };
});

vi.mock('./supabase', () => ({
  getSupabaseClient: supabaseMocks.getSupabaseClient,
}));

import { registerConsoleProofArtifact } from './proof-artifacts';

describe('proof-artifacts', () => {
  beforeEach(() => {
    supabaseMocks.from.mockClear();
    supabaseMocks.schema.mockClear();
    supabaseMocks.upload.mockReset();
    supabaseMocks.rpc.mockReset();
    supabaseMocks.getSupabaseClient.mockReset();
    supabaseMocks.getSupabaseClient.mockReturnValue({
      storage: { from: supabaseMocks.from },
      schema: supabaseMocks.schema,
    });
    supabaseMocks.upload.mockResolvedValue({ data: { path: 'uploaded' }, error: null });
    supabaseMocks.rpc.mockResolvedValue({
      data: [{ artifact_id: 'art_123' }],
      error: null,
    });
  });

  it('uploads Console proof to fieldops evidence and registers it through the api schema RPC', async () => {
    const file = new File(['proof'], 'Proof Photo.PNG', { type: 'image/png' });

    await expect(
      registerConsoleProofArtifact({
        file,
        artifactKind: 'photo',
        organizationId: 'org_1',
        taskId: 'task_1',
        routeStopId: 'stop_1',
        routeRunId: 'run_1',
        shipmentId: 'shipment_1',
      }),
    ).resolves.toBe('art_123');

    expect(supabaseMocks.from).toHaveBeenCalledWith('fieldops-evidence');
    expect(supabaseMocks.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^org_1\/task_1\/.+\.png$/),
      file,
      expect.objectContaining({ contentType: 'image/png', upsert: false }),
    );
    expect(supabaseMocks.schema).toHaveBeenCalledWith('api');
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('register_mobile_artifact_v1', {
      p_artifact: expect.objectContaining({
        organization_id: 'org_1',
        storage_bucket: 'fieldops-evidence',
        storage_key: expect.stringMatching(/^org_1\/task_1\/.+\.png$/),
        mime_type: 'image/png',
        size_bytes: file.size,
        source_system: 'console_v2',
        metadata: expect.objectContaining({
          app: 'console-v2',
          artifact_kind: 'photo',
          proof_use: 'route_stop_closeout',
          task_id: 'task_1',
          route_stop_id: 'stop_1',
          route_run_id: 'run_1',
          shipment_id: 'shipment_1',
          original_name: 'Proof Photo.PNG',
        }),
      }),
    });
  });

  it('fails closed when Console is not using a backend Supabase session', async () => {
    supabaseMocks.getSupabaseClient.mockReturnValue(null);

    await expect(
      registerConsoleProofArtifact({
        file: new File(['proof'], 'proof.txt', { type: 'text/plain' }),
        artifactKind: 'signature',
        organizationId: 'org_1',
        taskId: 'task_1',
        routeStopId: 'stop_1',
        routeRunId: 'run_1',
        shipmentId: 'shipment_1',
      }),
    ).rejects.toThrow('Proof upload requires a backend-backed Console session');
  });
});
