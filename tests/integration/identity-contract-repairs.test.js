const { randomUUID } = require('crypto');
const {
  DATABASE_URL,
  pool,
  cleanupAutoOnboardingArtifacts,
  createOrganization,
  createUser,
  setAuthContext,
  withFixtureAdminContext,
} = require('./helpers/tenant-utils');

const describeIfDb = DATABASE_URL ? describe : describe.skip;

async function expectDenied(client, sql, params, code = '42501') {
  await client.query('SAVEPOINT identity_contract_denied');
  try {
    await expect(client.query(sql, params)).rejects.toMatchObject({ code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT identity_contract_denied');
    await client.query('RELEASE SAVEPOINT identity_contract_denied');
  }
}

describeIfDb('identity contract runtime', () => {
  let client;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  test('shared resolver handles JSON-array fallbacks and rejects non-string entries', async () => {
    const resolved = await client.query(
      'SELECT workflow_handlers.resolve_path_text($1::jsonb, $2::text) AS value',
      [{ primary: null, fallback: { code: 'resolved' } }, '["$.primary","$.fallback.code"]'],
    );
    expect(resolved.rows[0].value).toBe('resolved');

    await client.query('SAVEPOINT identity_contract_bad_path');
    try {
      await expect(
        client.query(
          'SELECT workflow_handlers.resolve_path_text($1::jsonb, $2::text)',
          [{ value: 'unsafe' }, '["$.value",1]'],
        ),
      ).rejects.toMatchObject({ code: '22023' });
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT identity_contract_bad_path');
      await client.query('RELEASE SAVEPOINT identity_contract_bad_path');
    }
  });

  test('unauthorized missing branch commands deny before revealing existence', async () => {
    const org = await createOrganization(client, 'Identity Contract Denied Org');
    const userId = await createUser(
      client,
      org.id,
      `identity-contract-driver-${randomUUID()}@example.com`,
      { userType: 'driver', provisionRbac: false },
    );
    await setAuthContext(client, userId);

    await expectDenied(
      client,
      'SELECT api.branch_zone_assign_v1($1::jsonb)',
      [{ branch_id: randomUUID(), zone_id: randomUUID() }],
    );
    await expectDenied(
      client,
      'SELECT api.branch_zone_unassign_v1($1::jsonb)',
      [{ branch_zone_id: randomUUID() }],
    );
    await expectDenied(
      client,
      'SELECT api.add_branch_member_v1($1::jsonb)',
      [{ branch_id: randomUUID(), user_id: randomUUID(), role_key: 'cashier' }],
    );
  });

  test('authorized missing unassign is idempotent without audit pollution', async () => {
    const org = await createOrganization(client, 'Identity Contract Authorized Org');
    const userId = await createUser(
      client,
      org.id,
      `identity-contract-operator-${randomUUID()}@example.com`,
      { userType: 'ops_admin' },
    );
    await setAuthContext(client, userId);

    const call = await client.query(
      'SELECT api.branch_zone_unassign_v1($1::jsonb) AS result',
      [{ branch_zone_id: randomUUID() }],
    );
    const result = call.rows[0].result;
    expect(result).toMatchObject({ ok: true, already_processed: true });
    expect(result.settings_resolution_id).toBeUndefined();

    const audit = await withFixtureAdminContext(client, (adminClient) =>
      adminClient.query(
        `SELECT
           (SELECT count(*)::int FROM public.decision_log WHERE correlation_id = $1::uuid) AS decisions,
           (SELECT count(*)::int FROM public.domain_events WHERE correlation_id = $1::uuid) AS events`,
        [result.correlation_id],
      ),
    );
    expect(audit.rows[0]).toEqual({ decisions: 0, events: 0 });
  });

  test('branch zone assignment replay and removal preserve lineage and tenant isolation', async () => {
    const org = await createOrganization(client, 'Branch zone contract');
    const foreign = await createOrganization(client, 'Foreign branch zone contract');
    const owner = await createUser(client, org.id, `${randomUUID()}@example.test`, { userType: 'ops_admin' });
    const outsider = await createUser(client, foreign.id, `${randomUUID()}@example.test`, { userType: 'ops_admin' });
    const branch = randomUUID(), foreignBranch = randomUUID();
    const zone = randomUUID(), foreignZone = randomUUID();
    await withFixtureAdminContext(client, async c => {
      await c.query(`INSERT INTO public.branches(id,organization_id,code,name,timezone,is_active)
        VALUES ($1::uuid,$2::uuid,$1::text,'Owned branch','UTC',true),($3::uuid,$4::uuid,$3::text,'Foreign branch','UTC',true)`,
        [branch,org.id,foreignBranch,foreign.id]);
      await c.query(`INSERT INTO public.zones(id,organization_id,name,slug)
        VALUES ($1::uuid,$2::uuid,'Owned zone',$1::text),($3::uuid,$4::uuid,'Foreign zone',$3::text)`,
        [zone,org.id,foreignZone,foreign.id]);
    });
    const assign = async args => (await client.query('SELECT api.branch_zone_assign_v1($1::jsonb) result',[args])).rows[0].result;
    const unassign = async args => (await client.query('SELECT api.branch_zone_unassign_v1($1::jsonb) result',[args])).rows[0].result;
    const snapshot = async () => (await withFixtureAdminContext(client, c => c.query(
      `SELECT
        (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id),'[]') FROM public.branch_zones b WHERE branch_id=ANY($1::uuid[])) mappings,
        (SELECT count(*)::int FROM public.decision_log WHERE organization_id=ANY($2::uuid[]) AND decision_category IN ('branches.zone_assign','branches.zone_unassign')) decisions,
        (SELECT count(*)::int FROM public.domain_events WHERE organization_id=ANY($2::uuid[]) AND event_type IN ('branch_zone.assigned','branch_zone.unassigned')) events`,
      [[branch,foreignBranch],[org.id,foreign.id]]))).rows;
    const lineage = async (result, category, outcome, event, count) => {
      const proof = await withFixtureAdminContext(client, c => c.query(
        `SELECT
          (SELECT count(*)::int FROM public.decision_log WHERE id=$1::uuid AND correlation_id=$2::uuid
            AND resource_type='branch_zone' AND resource_id=$3::uuid AND organization_id=$4::uuid
            AND decision_category=$5 AND decision_outcome=$6) decisions,
          (SELECT count(*)::int FROM public.domain_events WHERE correlation_id=$2::uuid AND resource_id=$3::uuid
            AND resource_type='branch_zone' AND organization_id=$4::uuid AND event_type=$7
            AND payload->>'branch_id'=$8 AND payload->>'zone_id'=$9) events`,
        [result.settings_resolution_id,result.correlation_id,result.branch_zone_id,org.id,category,outcome,event,branch,zone]));
      expect(proof.rows).toEqual([{decisions:1,events:count}]);
    };
    await setAuthContext(client, owner);
    const args = {branch_id:branch,zone_id:zone,priority:2};
    const first = await assign(args);
    expect(first).toMatchObject({ok:true,already_processed:false});
    expect(first.branch_zone_id).toBeTruthy();
    const replay = await assign(args);
    expect(replay).toMatchObject({ok:true,already_processed:true,branch_zone_id:first.branch_zone_id});
    const before = await snapshot();
    expect(before[0]).toMatchObject({decisions:2,events:1});
    expect(before[0].mappings).toHaveLength(1);
    expect(before[0].mappings[0]).toMatchObject({id:first.branch_zone_id,branch_id:branch,zone_id:zone,priority:2});
    await lineage(first,'branches.zone_assign','assigned','branch_zone.assigned',1);
    await lineage(replay,'branches.zone_assign','already_assigned','branch_zone.assigned',0);
    await expectDenied(client,'SELECT api.branch_zone_assign_v1($1::jsonb)',[{branch_id:foreignBranch,zone_id:foreignZone}]);
    await expectDenied(client,'SELECT api.branch_zone_assign_v1($1::jsonb)',[{branch_id:branch,zone_id:foreignZone}],'23514');
    await setAuthContext(client, outsider);
    await expectDenied(client,'SELECT api.branch_zone_unassign_v1($1::jsonb)',[{branch_zone_id:first.branch_zone_id}]);
    await expectDenied(client,'SELECT api.branch_zone_unassign_v1($1::jsonb)',[{branch_id:branch,zone_id:zone}]);
    expect(await snapshot()).toEqual(before);
    await setAuthContext(client, owner);
    const removed = await unassign({branch_zone_id:first.branch_zone_id});
    expect(removed).toMatchObject({ok:true,already_processed:false,branch_zone_id:first.branch_zone_id});
    await lineage(removed,'branches.zone_unassign','unassigned','branch_zone.unassigned',1);
    const after = await snapshot();
    expect(after[0].mappings).toEqual([]);
    expect(after[0].decisions).toBe(before[0].decisions+1);
    expect(after[0].events).toBe(before[0].events+1);
    const missing = await unassign({branch_zone_id:first.branch_zone_id});
    expect(missing).toMatchObject({ok:true,already_processed:true});
    expect(missing.settings_resolution_id).toBeUndefined();
    expect(await snapshot()).toEqual(after);
  });

  test('concurrent identical branch zone assignments converge on one mapping', async () => {
    let fixture;
    await withFixtureAdminContext(pool, async (adminClient) => {
      const org = await createOrganization(adminClient, 'Concurrent branch zone contract');
      const owner = await createUser(
        adminClient,
        org.id,
        `concurrent-branch-zone-${randomUUID()}@example.test`,
        { userType: 'ops_admin' },
      );
      const branchId = randomUUID();
      const competingBranchId = randomUUID();
      const zoneId = randomUUID();
      await adminClient.query(
        `INSERT INTO public.branches(id,organization_id,code,name,timezone,is_active)
         VALUES ($1::uuid,$2::uuid,$1::text,'Concurrent branch','UTC',true),
                ($3::uuid,$2::uuid,$3::text,'Competing branch','UTC',true)`,
        [branchId, org.id, competingBranchId],
      );
      await adminClient.query(
        `INSERT INTO public.zones(id,organization_id,name,slug)
         VALUES ($1::uuid,$2::uuid,'Concurrent zone',$1::text)`,
        [zoneId, org.id],
      );
      fixture = { organizationId: org.id, owner, branchId, competingBranchId, zoneId };
    });

    const coordinator = await pool.connect();
    const workerPids = [];
    const invoke = async () => {
      const worker = await pool.connect();
      try {
        await worker.query('BEGIN');
        await worker.query("SET LOCAL statement_timeout = '10s'");
        await setAuthContext(worker, fixture.owner);
        const backend = await worker.query('SELECT pg_backend_pid()::int AS pid');
        workerPids.push(backend.rows[0].pid);
        const result = await worker.query(
          'SELECT api.branch_zone_assign_v1($1::jsonb) AS result',
          [{ branch_id: fixture.branchId, zone_id: fixture.zoneId, priority: 2 }],
        );
        await worker.query('COMMIT');
        return result.rows[0].result;
      } catch (error) {
        await worker.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        worker.release();
      }
    };

    let workers = [];
    try {
      await coordinator.query('BEGIN');
      await coordinator.query('LOCK TABLE public.branch_zones IN SHARE MODE');
      workers = [invoke(), invoke()];
      const deadline = Date.now() + 5000;
      let blocked = 0;
      while (blocked < 2 && Date.now() < deadline) {
        if (workerPids.length < 2) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        const observed = await coordinator.query(
          `SELECT count(*)::int AS blocked
             FROM unnest($1::int[]) AS worker(pid)
            WHERE cardinality(pg_blocking_pids(worker.pid)) > 0`,
          [workerPids],
        );
        blocked = observed.rows[0].blocked;
        if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(2);
      await coordinator.query('COMMIT');

      const outcomes = await Promise.allSettled(workers);
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      const results = outcomes.map((outcome) => outcome.value);
      expect(new Set(results.map((result) => result.branch_zone_id)).size).toBe(1);
      expect(results.map((result) => result.already_processed).sort()).toEqual([false, true]);

      const conflictClient = await pool.connect();
      try {
        await conflictClient.query('BEGIN');
        await setAuthContext(conflictClient, fixture.owner);
        await expect(
          conflictClient.query('SELECT api.branch_zone_assign_v1($1::jsonb)', [{
            branch_id: fixture.competingBranchId,
            zone_id: fixture.zoneId,
            priority: 2,
          }]),
        ).rejects.toMatchObject({ code: '23505' });
        await conflictClient.query('ROLLBACK');
      } finally {
        conflictClient.release();
      }

      const proof = await withFixtureAdminContext(pool, (adminClient) =>
        adminClient.query(
          `SELECT
             (SELECT count(*)::int FROM public.branch_zones
               WHERE branch_id=$1::uuid AND zone_id=$2::uuid) AS mappings,
             (SELECT count(*)::int FROM public.decision_log
               WHERE organization_id=$3::uuid
                 AND decision_category='branches.zone_assign'
                 AND decision_outcome IN ('assigned','already_assigned')) AS decisions,
             (SELECT count(*)::int FROM public.domain_events
               WHERE organization_id=$3::uuid
                 AND event_type='branch_zone.assigned') AS events`,
          [fixture.branchId, fixture.zoneId, fixture.organizationId],
        ),
      );
      expect(proof.rows[0]).toEqual({ mappings: 1, decisions: 2, events: 1 });
    } finally {
      await coordinator.query('ROLLBACK').catch(() => {});
      coordinator.release();
      await Promise.allSettled(workers);
      await withFixtureAdminContext(pool, async (adminClient) => {
        await cleanupAutoOnboardingArtifacts(adminClient, fixture.organizationId);
        await adminClient.query(
          'DELETE FROM public.domain_events WHERE organization_id=$1::uuid',
          [fixture.organizationId],
        );
        await adminClient.query(
          `DELETE FROM public.settings
            WHERE scope_type='tenant' AND scope_id=$1::uuid`,
          [fixture.organizationId],
        );
        await adminClient.query(
          `DELETE FROM public.settings_versions
            WHERE scope_type='tenant' AND scope_id=$1::uuid`,
          [fixture.organizationId],
        );
        await adminClient.query(
          'DELETE FROM public.users WHERE organization_id=$1::uuid',
          [fixture.organizationId],
        );
        await adminClient.query(
          'DELETE FROM public.decision_log WHERE organization_id=$1::uuid',
          [fixture.organizationId],
        );
        await adminClient.query(
          'DELETE FROM public.organizations WHERE id=$1::uuid',
          [fixture.organizationId],
        );
      });
    }
  });

  test('member add preserves normalized role timestamps replay and ownership', async () => {
    const org = await createOrganization(client, 'Member contract');
    const foreign = await createOrganization(client, 'Foreign member contract');
    const owner = await createUser(client, org.id, `${randomUUID()}@example.test`, { userType: 'ops_admin' });
    const outsider = await createUser(client, foreign.id, `${randomUUID()}@example.test`, { userType: 'ops_admin' });
    const branch = randomUUID();
    const foreignBranch = randomUUID();
    await withFixtureAdminContext(client, c => c.query(
      `INSERT INTO public.branches(id, organization_id, code, name, timezone, is_active)
       VALUES ($1::uuid,$2::uuid,$1::text,'Member fixture','UTC',true),
              ($3::uuid,$4::uuid,$3::text,'Foreign fixture','UTC',true)`,
      [branch, org.id, foreignBranch, foreign.id]));
    await setAuthContext(client, owner);
    const invoke = async args => (await client.query('SELECT api.add_branch_member_v1($1::jsonb) AS result', [args])).rows[0].result;
    const args = { branch_id: branch, user_id: owner, role_key: ' CASHIER ', metadata: { fixture: true } };
    const first = await invoke(args);
    const second = await invoke(args);
    expect(first).toMatchObject({ ok: true, already_processed: false });
    expect(second).toMatchObject({ ok: true, branch_membership_id: first.branch_membership_id, already_processed: true });
    const snapshot = async () => (await withFixtureAdminContext(client, c => c.query(
      `SELECT m.*, (SELECT count(*)::int FROM public.domain_events WHERE resource_id=m.id AND event_type='branch_membership.added') AS events,
        (SELECT count(*)::int FROM public.decision_log WHERE resource_id=m.id AND decision_category='branches.member_add') AS decisions,
        effective_from=transaction_timestamp() AS default_time
       FROM public.branch_memberships m WHERE branch_id=$1::uuid ORDER BY id`, [branch]))).rows;
    const before = await snapshot();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ role_key: 'cashier', metadata: { fixture: true }, default_time: true, events: 1, decisions: 2 });
    for (const [result, outcome, events] of [[first, 'added', 1], [second, 'already_active', 0]]) {
      const lineage = await withFixtureAdminContext(client, c => c.query(
        `SELECT (SELECT decision_outcome FROM public.decision_log WHERE id=$1::uuid AND resource_id=$2::uuid AND correlation_id=$3::uuid) AS outcome,
         (SELECT count(*)::int FROM public.domain_events WHERE resource_id=$2::uuid AND correlation_id=$3::uuid AND event_type='branch_membership.added') AS events`,
        [result.settings_resolution_id, result.branch_membership_id, result.correlation_id]));
      expect(lineage.rows).toEqual([{ outcome, events }]);
    }
    for (const [input, code] of [
      [{ ...args, branch_id: null }, '23502'],
      [{ ...args, user_id: null }, '23502'],
      [{ ...args, role_key: ' ' }, '23502'],
      [{ ...args, branch_id: randomUUID() }, '23503'],
      [{ ...args, branch_id: foreignBranch }, '42501'],
      [{ ...args, user_id: outsider }, '23514'],
    ]) await expectDenied(client, 'SELECT api.add_branch_member_v1($1::jsonb)', [input], code);
    expect(await snapshot()).toEqual(before);
    const dated = await invoke({ ...args, role_key: 'ops', effective_from: '2026-01-01T00:00:00Z' });
    const dateProof = await withFixtureAdminContext(client, c => c.query(
      `SELECT effective_from='2026-01-01T00:00:00Z'::timestamptz AS exact FROM public.branch_memberships WHERE id=$1::uuid`,
      [dated.branch_membership_id]));
    expect(dateProof.rows).toEqual([{ exact: true }]);
  });

  test('dispute API escalation enforces the canonical contract and returns UUID lineage', async () => {
    const openedOrg = await createOrganization(client, 'Identity Contract Dispute Org');
    const counterpartyOrg = await createOrganization(client, 'Identity Contract Counterparty Org');
    const userId = await createUser(
      client,
      openedOrg.id,
      `identity-contract-dispute-${randomUUID()}@example.com`,
      { userType: 'ops_admin' },
    );
    const disputeId = randomUUID();

    await withFixtureAdminContext(client, (adminClient) =>
      adminClient.query(
        `INSERT INTO public.marketplace_disputes (
           id, opened_by_organization_id, counterparty_organization_id,
           opened_by_user_id, status, category, title, metadata
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'open', 'general', $5, '{}'::jsonb)`,
        [disputeId, openedOrg.id, counterpartyOrg.id, userId, 'Identity contract dispute'],
      ),
    );
    await setAuthContext(client, userId);

    const call = await client.query(
      'SELECT api.dispute_escalate_v1($1::jsonb) AS result',
      [{ dispute_id: disputeId, escalation_reason: 'Focused runtime contract test' }],
    );
    const result = call.rows[0].result;
    expect(result).toMatchObject({ ok: true, dispute_id: disputeId, status: 'under_review' });
    expect(result.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(result.settings_resolution_id).toMatch(/^[0-9a-f-]{36}$/i);

    const evidence = await withFixtureAdminContext(client, (adminClient) =>
      adminClient.query(
        `SELECT
           (SELECT status FROM public.marketplace_disputes WHERE id = $1::uuid) AS status,
           (SELECT count(*)::int FROM public.decision_log
             WHERE correlation_id = $2::uuid AND decision_category = 'dispute.escalate') AS decisions,
           (SELECT count(*)::int FROM public.domain_events
             WHERE correlation_id = $2::uuid AND event_type = 'dispute.escalated') AS events`,
        [disputeId, result.correlation_id],
      ),
    );
    expect(evidence.rows[0]).toEqual({ status: 'under_review', decisions: 1, events: 1 });
  });

  test('dispute repeat participant and denial contracts preserve exact owned evidence', async () => {
    const opened = await createOrganization(client, 'Escalation owner');
    const counter = await createOrganization(client, 'Escalation counterparty');
    const foreign = await createOrganization(client, 'Escalation unrelated');
    const actor = await createUser(client, opened.id, `${randomUUID()}@example.test`, { userType: 'ops_admin' });
    const counterActor = await createUser(client, counter.id, `${randomUUID()}@example.test`, { userType: 'ops_admin' });
    const foreignActor = await createUser(client, foreign.id, `${randomUUID()}@example.test`, { userType: 'ops_admin' });
    const deniedActor = await createUser(client, opened.id, `${randomUUID()}@example.test`, { userType: 'driver', provisionRbac: false });
    const id = randomUUID();
    await withFixtureAdminContext(client, c => c.query(
      `INSERT INTO public.marketplace_disputes(id,opened_by_organization_id,counterparty_organization_id,opened_by_user_id,status,category,title,metadata)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'open','general','Escalation fixture','{"retained":true}')`,
      [id, opened.id, counter.id, actor]));
    const invoke = async args => (await client.query('SELECT api.dispute_escalate_v1($1::jsonb) AS result', [args])).rows[0].result;
    const snapshot = async () => (await withFixtureAdminContext(client, c => c.query(
      `SELECT to_jsonb(d) AS dispute,
       (SELECT count(*)::int FROM public.decision_log WHERE resource_id=d.id AND decision_category='dispute.escalate') AS decisions,
       (SELECT count(*)::int FROM public.domain_events WHERE resource_id=d.id AND event_type='dispute.escalated') AS events
       FROM public.marketplace_disputes d WHERE id=$1::uuid`, [id]))).rows;
    await setAuthContext(client, actor);
    const first = await invoke({ dispute_id: id, escalation_reason: ' First ', metadata: { added: true } });
    await setAuthContext(client, counterActor);
    const second = await invoke({ dispute_id: id, escalation_reason: ' Follow-up ', metadata: [] });
    expect(first).toMatchObject({ ok: true, status: 'under_review', escalation_count: 1 });
    expect(second).toMatchObject({ ok: true, status: 'under_review', escalation_count: 2 });
    expect(second.correlation_id).not.toBe(first.correlation_id);
    const good = await snapshot();
    expect(good).toHaveLength(1);
    expect(good[0]).toMatchObject({ decisions: 2, events: 2, dispute: { status: 'under_review', metadata: {
      retained: true, added: true, escalation_count: 2, last_escalation_reason: 'Follow-up', last_escalated_by_user_id: counterActor,
    } } });
    expect(good[0].dispute.metadata.last_escalated_at).toBeTruthy();
    for (const result of [first, second]) {
      const proof = await withFixtureAdminContext(client, c => c.query(
        `SELECT (SELECT count(*)::int FROM public.decision_log WHERE resource_id=$1::uuid AND correlation_id=$2::uuid AND id=$3::uuid) AS decisions,
         (SELECT count(*)::int FROM public.domain_events WHERE resource_id=$1::uuid AND correlation_id=$2::uuid AND event_type='dispute.escalated') AS events`,
        [id, result.correlation_id, result.settings_resolution_id]));
      expect(proof.rows).toEqual([{ decisions: 1, events: 1 }]);
    }
    for (const user of [foreignActor, deniedActor]) {
      await setAuthContext(client, user);
      await expectDenied(client, 'SELECT api.dispute_escalate_v1($1::jsonb)', [{ dispute_id: id, escalation_reason: 'Denied' }]);
    }
    await setAuthContext(client, actor);
    for (const [args, code] of [
      [{ escalation_reason: 'reason' }, '23502'],
      [{ dispute_id: 'invalid', escalation_reason: 'reason' }, '23502'],
      [{ dispute_id: id, escalation_reason: ' ' }, '23502'],
      [{ dispute_id: randomUUID(), escalation_reason: 'reason' }, 'P0002'],
    ]) await expectDenied(client, 'SELECT api.dispute_escalate_v1($1::jsonb)', [args], code);
    expect(await snapshot()).toEqual(good);
    for (const status of ['resolved', 'rejected']) {
      await withFixtureAdminContext(client, c => c.query('UPDATE public.marketplace_disputes SET status=$2 WHERE id=$1::uuid', [id, status]));
      const before = await snapshot();
      await expectDenied(client, 'SELECT api.dispute_escalate_v1($1::jsonb)', [{ dispute_id: id, escalation_reason: 'Denied' }], '22023');
      expect(await snapshot()).toEqual(before);
    }
  });

  test('browser-facing repair RPCs exist in the exposed API schema', async () => {
    const result = await client.query(`
      SELECT ARRAY[
        to_regprocedure('api.dispute_escalate_v1(jsonb)')::text,
        to_regprocedure('api.branch_zone_assign_v1(jsonb)')::text,
        to_regprocedure('api.branch_zone_unassign_v1(jsonb)')::text,
        to_regprocedure('api.add_branch_member_v1(jsonb)')::text
      ] AS functions
    `);
    expect(result.rows[0].functions).toHaveLength(4);
    expect(result.rows[0].functions.every(Boolean)).toBe(true);
  });
});
