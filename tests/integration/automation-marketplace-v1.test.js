const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const {
  createOrganization,
  createUser: nativeCreateUser,
  withFixtureAdminContext,
  setAuthContext,
} = require('./helpers/tenant-utils');

// Native DB suite: UNRUN offline. Setup uses existing fixture-admin helpers; actions use real actor roles.

async function createUser(client, organizationId, email, options) {
  const user = await nativeCreateUser(client, organizationId, email, options);
  await withFixtureAdminContext(client, async (admin) => {
    const { rows: [actor] } = await admin.query(
      `SELECT user_type,
              CASE WHEN access_scope_type='platform' THEN public.get_root_scope_type_key_v1() ELSE access_scope_type END AS scope_type,
              CASE WHEN access_scope_type='tenant' THEN organization_id ELSE access_scope_id END AS scope_id
         FROM public.users WHERE id=$1 AND organization_id=$2`,
      [user, organizationId]
    );
    // Lock before reading: a single statement could retain a pre-wait snapshot.
    await admin.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `sg13:access_control_policy:${actor.scope_type}:${actor.scope_id || 'root'}`,
    ]);
    const { rows: [policy] } = await admin.query(
      `WITH effective AS (SELECT public.resolve_settings_merged('access_control_policy',$1,$2) AS value)
       SELECT effective.value AS effective,
              public.resolve_role_keys_v1(effective.value,$3,$4) AS role_keys,
              COALESCE((SELECT sv.value FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
                        WHERE s.category='access_control_policy' AND s.scope_type=$1 AND s.scope_id IS NOT DISTINCT FROM $2), '{}'::jsonb) AS scoped,
              (SELECT MAX(version) FROM public.schema_registry WHERE category='access_control_policy' AND is_active) AS schema_version
         FROM effective`,
      [actor.scope_type, actor.scope_id, user, actor.user_type]
    );
    const marketplaceRoles = ['automation_marketplace_publisher', 'automation_marketplace_installer'];
    if (marketplaceRoles.some(key => !policy.effective?.roles?.some(role => role.key === key))) {
      throw new Error('Missing explicit marketplace policy role');
    }
    const assignments = policy.scoped.assignments || {};
    const value = {
      ...policy.scoped,
      assignments: {
        ...assignments,
        user_id: {
          ...assignments.user_id,
          [user]: [...new Set([...(policy.role_keys || []), ...marketplaceRoles])],
        },
      },
    };
    await admin.query(
      `SELECT * FROM public.upsert_settings_value_v1('access_control_policy',$1,$2,$3::jsonb,$4,'SG13 explicit actor roles')`,
      [actor.scope_type, actor.scope_id, JSON.stringify(value), policy.schema_version]
    );
  });
  return user;
}

loadEnv();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const manifest = {
  display: { title: 'Automation Asset', summary: 'Marketplace test asset' },
  docs: {},
  variable_schema: { keys: ['channel'] },
  connection_requirements: { bindings: [] },
  dependency_requirements: { required_assets: [] },
  capability_requirements: [],
  install_constraints: { allowed_scope_placeholders: [] },
  egress_profile: {},
  compatibility: {},
  artifact_hash: '',
};

describeIfDb('automation marketplace lifecycle', () => {
  let client;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
      client = null;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  test('explicit marketplace role assignments can publish and install an isolated workflow copy', async () => {
    const org = await createOrganization(client, `Automation Marketplace Org ${Date.now()}`);
    const userId = await createUser(
      client,
      org.id,
      `automation-marketplace-${Date.now()}@example.com`,
      { userType: 'ops_admin' }
    );

    await setAuthContext(client, userId);

    const workflowName = `automation-marketplace-template-${randomUUID()}`;
    const { rows: createdRows } = await client.query(
      `SELECT public.ui_create_workflow_template_v1($1, $2, NULL) AS result`,
      [workflowName, 'Automation marketplace integration test workflow']
    );
    const workflowTemplateId = createdRows[0].result.workflow_template_id;

    await client.query(
      `SELECT public.ui_create_workflow_template_step_v1($1::uuid, $2::jsonb)`,
      [
        workflowTemplateId,
        JSON.stringify({
          operation_name: 'workflow_control',
          transition_condition: 'success',
          handler_key: 'workflow_control',
          enabled: true,
        }),
      ]
    );

    const { rows: listingRows } = await client.query(
      `SELECT public.automation_asset_create_listing_v1($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9) AS result`,
      [
        'workflow_template',
        workflowTemplateId,
        'Workflow Marketplace Asset',
        'Integration test listing',
        'private',
        JSON.stringify(manifest),
        JSON.stringify({}),
        JSON.stringify({ source: 'integration-test' }),
        'capture workflow revision during test',
      ]
    );

    const listing = listingRows[0].result;
    expect(listing.ok).toBe(true);
    expect(typeof listing.listing_id).toBe('string');
    expect(typeof listing.listing_version_id).toBe('string');

    await client.query(
      `SELECT public.automation_asset_publish_version_v1($1::uuid, $2)`,
      [listing.listing_version_id, 'private']
    );

    const { rows: installRows } = await client.query(
      `SELECT public.automation_asset_install_v1($1::uuid, $2, $3::uuid, $4::jsonb, $5::jsonb, $6) AS result`,
      [
        listing.listing_version_id,
        'tenant',
        org.id,
        JSON.stringify({ channel: 'otp' }),
        JSON.stringify({}),
        false,
      ]
    );

    const install = installRows[0].result;
    expect(install.ok).toBe(true);
    expect(install.activation_result).toEqual({activated:false});
    expect(install.installed_resource_type).toBe('workflow_template');
    expect(install.installed_resource_id).not.toBe(workflowTemplateId);

    const { rows: copiedTemplateRows } = await client.query(
      `SELECT id, name, scope_type, scope_id
         FROM public.workflow_templates
        WHERE id = $1::uuid`,
      [install.installed_resource_id]
    );
    expect(copiedTemplateRows).toHaveLength(1);
    expect(copiedTemplateRows[0].scope_type).toBe('tenant');
    expect(copiedTemplateRows[0].scope_id).toBe(org.id);

    const { rows: copiedStepRows } = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM public.workflow_template_steps
        WHERE workflow_template_id = $1::uuid`,
      [install.installed_resource_id]
    );
    expect(copiedStepRows[0].count).toBe(1);

    const { rows: installVariableRows } = await client.query(
      `SELECT variable_key, value
         FROM public.automation_asset_install_variables
        WHERE install_id = $1::uuid`,
      [install.install_id]
    );
    expect(installVariableRows).toHaveLength(1);
    expect(installVariableRows[0].variable_key).toBe('channel');
    expect(installVariableRows[0].value).toEqual('otp');
  });

  test('connection upsert stores vault ref and redacted hint instead of plaintext secret columns', async () => {
    const org = await createOrganization(client, `Automation Marketplace Secret Org ${Date.now()}`);
    const userId = await createUser(
      client,
      org.id,
      `automation-marketplace-secret-${Date.now()}@example.com`,
      { userType: 'ops_admin' }
    );

    await setAuthContext(client, userId);

    const { rows } = await client.query(
      `SELECT public.integration_connection_upsert_v1(
         NULL,
         'tenant',
         $1::uuid,
         NULL,
         $2,
         $3,
         'api_key',
         '{}'::jsonb,
         '{}'::jsonb,
         '{}'::jsonb,
         $4::jsonb,
         'vault',
         false,
         NULL
       ) AS result`,
      [org.id, `provider-${Date.now()}`, 'OTP Provider Connection', JSON.stringify({ secret: 'top-secret-token' })]
    );

    const result = rows[0].result;
    expect(result.ok).toBe(true);
    expect(typeof result.connection_id).toBe('string');

    await client.query('SAVEPOINT denied_secret_read');
    await expect(client.query('SELECT credentials_vault_id FROM public.integration_connections WHERE id=$1',[result.connection_id])).rejects.toMatchObject({code:'42501'});
    await client.query('ROLLBACK TO SAVEPOINT denied_secret_read');
    const { rows: connectionRows } = await withFixtureAdminContext(client, (admin) => admin.query(
      `SELECT credentials_vault_id, verifier_secret_hash, secret_hint FROM public.integration_connections WHERE id=$1`,
      [result.connection_id]
    ));

    expect(connectionRows).toHaveLength(1);
    expect(connectionRows[0].credentials_vault_id).toBeTruthy();
    expect(connectionRows[0].verifier_secret_hash).toBeNull();
    expect(String(connectionRows[0].secret_hint || '')).not.toContain('top-secret-token');
    expect(String(connectionRows[0].secret_hint || '')).toMatch(/^\*+oken$/);
  });

  test('local credential presence checks real material and records only successful generation evidence', async () => {
    const org=await createOrganization(client,'SG13 presence '+randomUUID());
    const user=await createUser(client,org.id,randomUUID()+'@example.invalid',{userType:'ops_admin'});
    await setAuthContext(client,user);
    const connection=(await client.query("SELECT public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=$1,p_name:='synthetic empty',p_secret_payload:=$2::jsonb) AS result",[org.id,JSON.stringify({custom_selector:{value:'  '},empty:[]})])).rows[0].result;
    const check=async ()=>(await client.query('SELECT public.integration_connection_test_v1($1) AS result',[connection.connection_id])).rows[0].result;
    const empty=await check();
    expect(empty).toMatchObject({ok:false,status:'test_failed',test_kind:'credential_presence',remote_verified:false,last_tested_credential_generation:null});
    const failed=(await client.query('SELECT last_tested_at,last_tested_credential_generation FROM public.integration_connections WHERE id=$1',[connection.connection_id])).rows[0];
    expect(failed.last_tested_at).toBeTruthy();
    expect(failed.last_tested_credential_generation).toBeNull();
    await client.query('SELECT public.integration_connection_rotate_v1($1,$2::jsonb)',[connection.connection_id,JSON.stringify({custom_selector:{value:'synthetic-present'}})]);
    const present=await check();
    expect(present.ok).toBe(true);
    expect(present.remote_verified).toBe(false);
    expect(present.last_tested_credential_generation).toBe(present.credential_generation);
    await withFixtureAdminContext(client,admin=>admin.query("UPDATE public.integration_connections SET status='disabled' WHERE id=$1",[connection.connection_id]));
    expect(await check()).toMatchObject({ok:false,status:'disabled',last_tested_credential_generation:null});
  });

  test('hash-only connection stores verifier hash without vault reference', async () => {
    const org = await createOrganization(client, `Automation Marketplace Hash Org ${Date.now()}`);
    const userId = await createUser(
      client,
      org.id,
      `automation-marketplace-hash-${Date.now()}@example.com`,
      { userType: 'ops_admin' }
    );

    await setAuthContext(client, userId);

    const { rows } = await client.query(
      `SELECT public.integration_connection_upsert_v1(
         NULL,
         'tenant',
         $1::uuid,
         NULL,
         $2,
         $3,
         'hmac_shared_secret',
         '{}'::jsonb,
         '{}'::jsonb,
         '{}'::jsonb,
         $4::jsonb,
         'hash_only',
         false,
         NULL
       ) AS result`,
      [org.id, `hash-provider-${Date.now()}`, 'Hash Only Connection', JSON.stringify({ secret: 'hash-me-please' })]
    );

    const result = rows[0].result;
    expect(result.ok).toBe(true);
    expect(typeof result.connection_id).toBe('string');

    await client.query('SAVEPOINT denied_secret_read');
    await expect(client.query('SELECT credentials_vault_id FROM public.integration_connections WHERE id=$1',[result.connection_id])).rejects.toMatchObject({code:'42501'});
    await client.query('ROLLBACK TO SAVEPOINT denied_secret_read');
    const { rows: connectionRows } = await withFixtureAdminContext(client, (admin) => admin.query(
      `SELECT credentials_vault_id, verifier_secret_hash, secret_hint FROM public.integration_connections WHERE id=$1`,
      [result.connection_id]
    ));

    expect(connectionRows).toHaveLength(1);
    expect(connectionRows[0].credentials_vault_id).toBeNull();
    expect(connectionRows[0].verifier_secret_hash).toBeTruthy();
    expect(String(connectionRows[0].secret_hint || '')).not.toContain('hash-me-please');
    expect(String(connectionRows[0].secret_hint || '')).toMatch(/^\*+ease$/);
  });
});
