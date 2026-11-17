const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const migration = fs.readFileSync(path.join(root,
  'supabase/migrations/20260913104000_fieldops_route_stop_incident_composer_v1.sql'), 'utf8');
const returnMigration = fs.readFileSync(path.join(root,
  'supabase/migrations/20260913102000_fieldops_return_actions_route_stop_incident_v1.sql'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/fieldops/App.tsx'), 'utf8');

describe('F619 route-stop incident mobile contract', () => {
  test('registry declares required incident input and actor-owned task evidence', () => {
    for (const key of ["'incident_type'", "'summary'"]) expect(migration).toContain(key);
    expect(migration).toContain("'lookup_category','route_stop_incident_type'");
    expect(migration).toContain("'context','task','registration_rpc','register_mobile_artifact_v1'");
    expect(migration).toContain("'bucket','fieldops-evidence','min_items',1,'max_items',6");
    expect(migration).toContain("c.value->'execution','{}'::jsonb)-'idempotency'");
  });
  test('both registry migrations use the current six-argument settings contract', () => {
    for (const source of [returnMigration, migration]) {
      expect(source).toContain('sv.schema_version');
      expect(source).toMatch(/jsonb_set\(r\.value,'\{commands\}',v_(?:commands|next)\),r\.schema_version,\s*'[^']+'\)/);
    }
  });


  test('only actionable route-stop tasks expose the action', () => {
    expect(app).toMatch(/command\.key === "tasks\.report_incident"\) \{\s*return selectedTaskDetail\.id === selectedResourceId &&\s*selectedTaskActionable && selectedTaskSupportsRouteProgress/);
    expect(app).toContain('!isRouteStopExecutionTask(detailQuery.data?.detail)');
  });

  test('queues exact top-level params with stable retry key and no unsupported RPC args', () => {
    expect(app).toContain('const incidentParams = composerCommand.key === "tasks.report_incident" ? {');
    for (const key of ['incident_type: payload.incident_type', 'summary: payload.summary',
      'artifact_ids: payload.artifact_ids', 'paramsPatch: incidentParams ?? (',
      'if (command.key === "tasks.report_incident") nextParams.retry_key = queueId',
      'command.key === "tasks.report_incident" ? {} : composerRetryArgs']) expect(app).toContain(key);
    expect(app).toContain('composerSupportsPod || composerFinancialEvidence || composerIsIncident');
    expect(app).toContain('composerIsIncident ? 1 : 0');
  });

  test('refreshes mounted incident proof after sync and foreground resume', () => {
    expect(app).toContain('if (entry.args.p_action_key === "tasks.report_incident")');
    expect(app).toMatch(/AppState\.addEventListener\("change", state => \{\s*if \(state === "active"\) queryClient\.invalidateQueries\(\{ queryKey: \["incident-readback"\] \}\)/);
    expect(app).toContain('incidentReadbackQuery.data?.map(outcome => (');
    expect(app).toContain('if (!effectiveOnline) return records.map(record => ({ record, verified: false, proof: null }));');
    expect(app).toContain('incidentDisplayState === "error"');
    expect(app).toContain('outcome.verified && incidentDisplayState === "verified"');
  });

  test('missing readback authority after saved records shows the refreshable error state', () => {
    expect(app).toMatch(/const before = await resolveVerifiedCompletionScope\(client\);[\s\S]*?if \(!before \|\| before\.actor !== sessionUserId \|\| before\.scope !== completionReadbackScope\)\s*throw new Error\("Incident readback authority unavailable\."\)/);
    expect(app).toMatch(/const after = await resolveVerifiedCompletionScope\(client\);[\s\S]*?if \(!after \|\| after\.actor !== sessionUserId \|\| after\.scope !== completionReadbackScope\)\s*throw new Error\("Incident readback authority unavailable\."\)/);
    expect(app).toContain('if (captured !== completionReadbackCurrent.current || epoch !== completionReadbackScopeVersion()) return null;');
    expect(app).toContain('incidentDisplayState === "error"');
  });
});
