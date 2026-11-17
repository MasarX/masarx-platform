const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { loadEnv } = require('../../scripts/utils/load-env');
const { upsertSettings } = require('../utils/policies');
const {
  createOrganization,
  createClient,
  createSender,
  createUser: nativeCreateUser,
  withFixtureAdminContext,
  setFixtureAdminContext,
  createMappingConfig,
  cleanupAutoOnboardingArtifacts,
  createWorkflowTemplate,
  setAuthContext,
} = require('./helpers/tenant-utils');

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

function buildManifest(overrides = {}) {
  const manifest = {
    display: { title: 'Automation Asset', summary: 'Marketplace completion asset' },
    docs: {},
    variable_schema: { keys: [] },
    connection_requirements: { bindings: [] },
    dependency_requirements: { required_assets: [] },
    capability_requirements: [],
    install_constraints: {
      allowed_scope_placeholders: [],
      allowed_target_scope_types: ['tenant', 'client', 'sender'],
    },
    egress_profile: {},
    compatibility: {},
    artifact_hash: '',
  };

  return {
    ...manifest,
    ...overrides,
    display: { ...manifest.display, ...(overrides.display || {}) },
    variable_schema: { ...manifest.variable_schema, ...(overrides.variable_schema || {}) },
    connection_requirements: {
      ...manifest.connection_requirements,
      ...(overrides.connection_requirements || {}),
    },
    dependency_requirements: {
      ...manifest.dependency_requirements,
      ...(overrides.dependency_requirements || {}),
    },
    install_constraints: {
      ...manifest.install_constraints,
      ...(overrides.install_constraints || {}),
    },
  };
}

async function assignRoleTemplate(client, organizationId, userId, templateKey = 'ops_admin') {
  const { rows } = await client.query(
    'SELECT role_id FROM public.provision_rbac_roles_from_templates_v1($1::uuid, $2::text[], $3::uuid)',
    [organizationId, [templateKey], userId]
  );
  const roleId = rows[0]?.role_id || null;
  if (!roleId) throw new Error(`Unable to provision RBAC role template ${templateKey}`);

  await client.query(
    `INSERT INTO public.rbac_user_role_assignments (
        organization_id,
        user_id,
        role_id,
        assigned_by_user_id,
        metadata
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::jsonb
      )
      ON CONFLICT DO NOTHING`,
    [
      organizationId,
      userId,
      roleId,
      userId,
      JSON.stringify({ seed: true, source: 'automation-marketplace-completion', template_key: templateKey }),
    ]
  );
}

async function createWorkflowTemplateDraft(client, name, description = 'Marketplace completion workflow') {
  const { rows: createdRows } = await client.query(
    `SELECT public.ui_create_workflow_template_v1($1, $2, NULL) AS result`,
    [name, description]
  );
  const workflowTemplateId = createdRows[0]?.result?.workflow_template_id;
  if (!workflowTemplateId) {
    throw new Error('ui_create_workflow_template_v1 did not return workflow_template_id');
  }

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

  return workflowTemplateId;
}

async function activateWorkflowTemplate(client, workflowTemplateId) {
  // Re-enter draft so repeated activation checks exercise the real transition,
  // not the lifecycle RPC's already-active no-op. Negative callers use a savepoint.
  await client.query(
    "SELECT public.ui_set_workflow_template_status_v1($1::uuid, 'draft', $2)",
    [workflowTemplateId, 'Prepare marketplace fixture reactivation']
  );
  return client.query(
    "SELECT public.ui_set_workflow_template_status_v1($1::uuid, 'active', $2)",
    [workflowTemplateId, 'Activate marketplace fixture through the native lifecycle']
  );
}

async function createListing(client, params) {
  const {
    assetKind = 'workflow_template',
    sourceId,
    title = `Automation Marketplace Asset ${Date.now()}`,
    summary = 'Marketplace completion test listing',
    visibility = 'private',
    manifest = buildManifest(),
    docs = {},
    metadata = {},
    notes = 'create listing during completion proof',
  } = params;

  const { rows } = await client.query(
    `SELECT public.automation_asset_create_listing_v1($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9) AS result`,
    [
      assetKind,
      sourceId,
      title,
      summary,
      visibility,
      JSON.stringify(manifest),
      JSON.stringify(docs),
      JSON.stringify(metadata),
      notes,
    ]
  );
  return rows[0].result;
}

async function publishListingVersion(client, listingVersionId, visibility = 'private') {
  const { rows } = await client.query(
    `SELECT public.automation_asset_publish_version_v1($1::uuid, $2) AS result`,
    [listingVersionId, visibility]
  );
  return rows[0].result;
}

async function submitListingReview(client, listingVersionId, notes = 'submit for review') {
  const { rows } = await client.query(
    `SELECT public.automation_asset_submit_review_v1($1::uuid, $2) AS result`,
    [listingVersionId, notes]
  );
  return rows[0].result;
}

async function decideListingReview(client, reviewId, decision, notes = 'reviewed') {
  const { rows } = await client.query(
    `SELECT public.automation_asset_review_decide_v1($1::uuid, $2, $3) AS result`,
    [reviewId, decision, notes]
  );
  return rows[0].result;
}

async function installListing(client, params) {
  const {
    listingVersionId,
    targetScopeType,
    targetScopeId,
    variableValues = {},
    connectionBindings = {},
    activate = false,
  } = params;

  const { rows } = await client.query(
    `SELECT public.automation_asset_install_v1($1::uuid, $2, $3::uuid, $4::jsonb, $5::jsonb, $6) AS result`,
    [
      listingVersionId,
      targetScopeType,
      targetScopeId,
      JSON.stringify(variableValues),
      JSON.stringify(connectionBindings),
      activate,
    ]
  );
  return rows[0].result;
}

async function expectPgError(client, executor, messagePattern) {
  const savepoint = `sp_${randomUUID().replace(/-/g, '')}`;
  let caught = null;

  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await executor();
  } catch (error) {
    caught = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);

  if (!caught) {
    throw new Error(`Expected PostgreSQL error matching ${messagePattern}`);
  }

  expect(String(caught.message || caught)).toMatch(messagePattern);
  return caught;
}

async function createConnection(client, params) {
  const {
    ownerScopeType,
    ownerScopeId,
    providerKey,
    name,
    authType = 'api_key',
    config = {},
    oauthMetadata = {},
    metadata = {},
    secretPayload = null,
    secretStorageMode = 'vault',
    generateSecret = false,
    expiresAt = null,
  } = params;

  const { rows } = await client.query(
    `SELECT public.integration_connection_upsert_v1(
       NULL,
       $1,
       $2::uuid,
       NULL,
       $3,
       $4,
       $5,
       $6::jsonb,
       $7::jsonb,
       $8::jsonb,
       $9::jsonb,
       $10,
       $11,
       $12
     ) AS result`,
    [
      ownerScopeType,
      ownerScopeId,
      providerKey,
      name,
      authType,
      JSON.stringify(config),
      JSON.stringify(oauthMetadata),
      JSON.stringify(metadata),
      secretPayload ? JSON.stringify(secretPayload) : null,
      secretStorageMode,
      generateSecret,
      expiresAt,
    ]
  );
  return rows[0].result;
}

async function mergeWorkflowStepMetadata(client, workflowTemplateId, metadataPatch) {
  // Synthetic metadata includes deliberately invalid publication inputs. Prepare
  // only those rows as fixture admin; the helper restores the caller role/claims.
  await withFixtureAdminContext(client, admin => admin.query(
    `UPDATE public.workflow_template_steps
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE workflow_template_id = $1::uuid`,
    [workflowTemplateId, JSON.stringify(metadataPatch)]
  ));
}

async function createListingVersionFromCurrentWorkflow(client, {listingId,workflowTemplateId}) {
  const {rows} = await client.query('SELECT manifest,visibility FROM public.automation_asset_listing_versions WHERE listing_id=$1 ORDER BY listing_version_no DESC LIMIT 1',[listingId]);
  const {rows:created} = await client.query(
    'SELECT public.automation_asset_create_listing_v1($1,$2,NULL,NULL,$3,$4::jsonb,$5::jsonb,$5::jsonb,NULL,$6) AS result',
    ['workflow_template',workflowTemplateId,rows[0].visibility,JSON.stringify(rows[0].manifest),'{}',listingId]
  );
  await publishListingVersion(client,created[0].result.listing_version_id,rows[0].visibility);
  return created[0].result.listing_version_id;
}

async function createPluginVersionSource(client, params) {
  const {rows} = await client.query(
    'SELECT public.integration_plugin_generate_draft_v1($1,$2,p_workflow_binding:=jsonb_build_object($3::text,$4::uuid),p_plugin_key:=$5,p_organization_id:=$6) AS result',
    [params.pluginName,params.pluginKind || 'webhook','template_id',params.workflowTemplateId,params.pluginKey,params.organizationId]
  );
  return {pluginId:rows[0].result.plugin_id,pluginVersionId:rows[0].result.version_id};
}

describeIfDb('automation marketplace completion proof', () => {
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

  test('fixture policy assignments preserve other actors, baseline roles, denies and version history', async () => {
    const org = await createOrganization(client, `Marketplace Fixture Roles ${randomUUID()}`);
    const unassigned = await nativeCreateUser(client, org.id, `unassigned-${randomUUID()}@example.invalid`);
    let seededPolicy;
    let priorVersions;
    await withFixtureAdminContext(client, async (admin) => {
      const { rows: [baseline] } = await admin.query(
        `SELECT public.resolve_settings_merged('access_control_policy','tenant',$1) AS value,
          (SELECT COUNT(*)::int FROM public.settings_versions WHERE category='access_control_policy' AND scope_type='tenant' AND scope_id=$1) AS versions`,
        [org.id]
      );
      priorVersions = baseline.versions;
      seededPolicy = {
        denies: [...(baseline.value.denies || []), { capability_key: 'automation_marketplace.review', scope_type: 'tenant', scope_id: org.id }],
        assignments: { user_id: { [unassigned]: ['ops_admin'] } },
      };
      await admin.query(
        `SELECT * FROM public.upsert_settings_value_v1('access_control_policy','tenant',$1,$2::jsonb,
          (SELECT MAX(version) FROM public.schema_registry WHERE category='access_control_policy' AND is_active),'SG13 fixture assignment regression')`,
        [org.id, JSON.stringify(seededPolicy)]
      );
    });
    const first = await createUser(client, org.id, `assigned-${randomUUID()}@example.invalid`);
    const second = await createUser(client, org.id, `assigned-${randomUUID()}@example.invalid`);
    await withFixtureAdminContext(client, async (admin) => {
      const { rows: [current] } = await admin.query(
        `SELECT sv.value, s.cached_value=sv.value AS cache_matches,
          (SELECT COUNT(*)::int FROM public.settings_versions WHERE category=s.category AND scope_type=s.scope_type AND scope_id=s.scope_id) AS versions,
          (SELECT COUNT(*)::int FROM public.settings_versions WHERE category=s.category AND scope_type=s.scope_type AND scope_id=s.scope_id AND effective_until IS NULL AND approved_at IS NOT NULL) AS open_versions
         FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
         WHERE s.category='access_control_policy' AND s.scope_type='tenant' AND s.scope_id=$1`,
        [org.id]
      );
      expect(current.value.denies).toEqual(seededPolicy.denies);
      expect(current.value.assignments.user_id[unassigned]).toEqual(['ops_admin']);
      for (const actor of [first, second]) {
        expect(current.value.assignments.user_id[actor]).toEqual(expect.arrayContaining([
          'ops_admin', 'automation_marketplace_publisher', 'automation_marketplace_installer',
        ]));
      }
      expect(current).toMatchObject({ cache_matches: true, versions: priorVersions + 3, open_versions: 1 });
    });
    await setAuthContext(client, first);
    const assigned = await client.query(`SELECT public.user_has_capability_v1('automation_marketplace.publish') AS publish,
      public.user_has_capability_v1('automation_marketplace.install') AS install,
      public.user_has_capability_v1('automation_marketplace.review') AS review`);
    expect(assigned.rows[0]).toEqual({ publish: true, install: true, review: false });
    await setAuthContext(client, unassigned);
    const denied = await client.query(`SELECT public.user_has_capability_v1('automation_marketplace.publish') AS publish,
      public.user_has_capability_v1('automation_marketplace.install') AS install`);
    expect(denied.rows[0]).toEqual({ publish: false, install: false });
  });

  test('public review approval gates install until approved and allows install after approval', async () => {
    const authorOrg = await createOrganization(client, `Marketplace Author Org ${Date.now()}`);
    const installerOrg = await createOrganization(client, `Marketplace Installer Org ${Date.now()}`);
    const authorUserId = await createUser(client, authorOrg.id, `author-${Date.now()}@example.com`, {
      userType: 'ops_admin',
    });
    const installerUserId = await createUser(client, installerOrg.id, `installer-${Date.now()}@example.com`, {
      userType: 'ops_admin',
    });
    const reviewerUserId = await createUser(client, authorOrg.id, `reviewer-${Date.now()}@example.com`, {
      userType: 'super_admin',
      accessScopeType: 'platform',
      accessScopeId: null,
      provisionRbac: false,
    });

    await setAuthContext(client, authorUserId);
    const workflowTemplateId = await createWorkflowTemplateDraft(
      client,
      `marketplace_public_${randomUUID()}`
    );
    const listing = await createListing(client, {
      sourceId: workflowTemplateId,
      visibility: 'private',
      manifest: buildManifest({
        variable_schema: { keys: ['channel'] },
      }),
    });

    const review = await submitListingReview(client, listing.listing_version_id);
    expect(review.ok).toBe(true);
    expect(review.publication_status).toBe('submitted');

    await setAuthContext(client, installerUserId);
    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_install_v1($1::uuid, $2, $3::uuid, $4::jsonb, $5::jsonb, $6)`,
        [
          listing.listing_version_id,
          'tenant',
          installerOrg.id,
          JSON.stringify({ channel: 'otp' }),
          JSON.stringify({}),
          false,
        ]
      ),
      /outside actor scope|requires an approved|must be approved/i
    );

    await setAuthContext(client, reviewerUserId);
    const approved = await decideListingReview(client, review.review_id, 'approved', 'approved in test');
    expect(approved.ok).toBe(true);
    expect(approved.decision).toBe('approved');

    await setAuthContext(client, installerUserId);
    const install = await installListing(client, {
      listingVersionId: listing.listing_version_id,
      targetScopeType: 'tenant',
      targetScopeId: installerOrg.id,
      variableValues: { channel: 'otp' },
    });
    expect(install.ok).toBe(true);
    expect(install.installed_resource_type).toBe('workflow_template');

    const { rows: installRows } = await client.query(
      `SELECT organization_id, target_scope_type, target_scope_id, install_status
         FROM public.automation_asset_installs
        WHERE id = $1::uuid`,
      [install.install_id]
    );
    expect(installRows).toHaveLength(1);
    expect(installRows[0].organization_id).toBe(installerOrg.id);
    expect(installRows[0].target_scope_type).toBe('tenant');
    expect(installRows[0].target_scope_id).toBe(installerOrg.id);
  });

  test('platform-scoped workflow publishing normalizes marketplace ownership to global without losing org provenance', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const org = await createOrganization(client, `Platform Marketplace Org ${Date.now()}`);
      const superAdminUserId = await createUser(
        client,
        org.id,
        `platform-publisher-${Date.now()}@example.com`,
        {
          userType: 'super_admin',
          accessScopeType: 'platform',
          accessScopeId: null,
          provisionRbac: false,
        }
      );
      await setAuthContext(client, superAdminUserId);

      const templateId = await createWorkflowTemplateDraft(
        client,
        `platform-marketplace-template-${randomUUID()}`,
        'Platform scoped workflow template publish proof'
      );

      const listing = await createListing(client, {
        sourceId: templateId,
        title: `Platform Listing ${Date.now()}`,
        visibility: 'private',
        manifest: buildManifest({
          variable_schema: { keys: ['channel'] },
        }),
      });

      const { rows } = await client.query(
        `SELECT listing.owner_scope_type,
                listing.owner_scope_id,
                listing.organization_id,
                version.source_snapshot_id,
                revision.scope_type AS revision_scope_type,
                revision.scope_id AS revision_scope_id,
                revision.organization_id AS revision_organization_id
           FROM public.automation_asset_listings listing
           JOIN public.automation_asset_listing_versions version
             ON version.id = $2::uuid
           JOIN public.workflow_template_revisions revision
             ON revision.id = version.source_snapshot_id
          WHERE listing.id = $1::uuid`,
        [listing.listing_id, listing.listing_version_id]
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].owner_scope_type).toBe('global');
      expect(rows[0].owner_scope_id).toBeNull();
      expect(rows[0].organization_id).toBe(org.id);
      expect(rows[0].revision_scope_type).toBe('global');
      expect(rows[0].revision_scope_id).toBeNull();
      expect(rows[0].revision_organization_id).toBe(org.id);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  test('review rejection persists rejected state and keeps install blocked', async () => {
    const org = await createOrganization(client, `Marketplace Reject Org ${Date.now()}`);
    const authorUserId = await createUser(client, org.id, `reject-author-${Date.now()}@example.com`, {
      userType: 'ops_admin',
    });
    const reviewerUserId = await createUser(client, org.id, `reject-reviewer-${Date.now()}@example.com`, {
      userType: 'super_admin',
      accessScopeType: 'platform',
      accessScopeId: null,
      provisionRbac: false,
    });

    await setAuthContext(client, authorUserId);
    const workflowTemplateId = await createWorkflowTemplateDraft(client, `reject_public_${randomUUID()}`);
    const listing = await createListing(client, { sourceId: workflowTemplateId });
    const review = await submitListingReview(client, listing.listing_version_id, 'reject me');

    await setAuthContext(client, reviewerUserId);
    const rejected = await decideListingReview(client, review.review_id, 'rejected', 'rejected in test');
    expect(rejected.ok).toBe(true);
    expect(rejected.decision).toBe('rejected');

    const { rows: reviewRows } = await client.query(
      `SELECT review_status FROM public.automation_asset_reviews WHERE id = $1::uuid`,
      [review.review_id]
    );
    expect(reviewRows[0].review_status).toBe('rejected');

    await setAuthContext(client, authorUserId);
    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_install_v1($1::uuid, $2, $3::uuid, $4::jsonb, $5::jsonb, $6)`,
        [
          listing.listing_version_id,
          'tenant',
          org.id,
          JSON.stringify({}),
          JSON.stringify({}),
          false,
        ]
      ),
      /outside actor scope|requires an approved|must be approved/i
    );
  });

  test('activated plugin installs call plugin activation with plugin-version scope arguments', async () => {
    const org = await createOrganization(client, `Marketplace Plugin Install Org ${Date.now()}`);
    const publisherUserId = await createUser(client, org.id, `plugin-install-${Date.now()}@example.com`, {
      userType: 'ops_admin',
    });

    await setAuthContext(client, publisherUserId);

    const templateId = await createWorkflowTemplateDraft(
      client,
      `marketplace-plugin-install-template-${randomUUID()}`,
      'Marketplace completion plugin activation target'
    );
    await activateWorkflowTemplate(client, templateId);
    const plugin = await createPluginVersionSource(client, {
      organizationId: org.id,
      workflowTemplateId: templateId,
      pluginKey: `marketplace-plugin-install-${Date.now()}`,
      pluginName: `Marketplace Plugin Install ${Date.now()}`,
    });
    const longKey='p'.repeat(120);
    await withFixtureAdminContext(client,admin=>admin.query('UPDATE public.integration_plugins SET plugin_key=$2 WHERE id=$1',[plugin.pluginId,longKey]));

    const listing = await createListing(client, {
      assetKind: 'integration_plugin',
      sourceId: plugin.pluginVersionId,
      title: `Plugin Listing ${Date.now()}`,
      summary: 'Plugin activation install proof',
      visibility: 'private',
      manifest: buildManifest(),
    });

    const published = await publishListingVersion(client, listing.listing_version_id, 'private');
    expect(published.ok).toBe(true);
    expect(published.publication_status).toBe('approved');

    const install = await installListing(client, {
      listingVersionId: listing.listing_version_id,
      targetScopeType: 'tenant',
      targetScopeId: org.id,
      activate: true,
    });
    expect(install.ok).toBe(true);
    expect(install.installed_resource_type).toBe('integration_plugin');
    expect(install.activation_result?.activated).toBe(true);
    expect(install.activation_result?.plugin_version_id).toBeTruthy();
    const repeated=await installListing(client,{listingVersionId:listing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id});
    const keys=(await client.query('SELECT plugin_key FROM public.integration_plugins WHERE id=ANY($1::uuid[]) ORDER BY plugin_key',[[install.installed_resource_id,repeated.installed_resource_id]])).rows.map(row=>row.plugin_key);
    expect(keys).toEqual(['p'.repeat(118)+'-2','p'.repeat(118)+'-3']);

    const { rows: pluginRows } = await client.query(
      `SELECT status, active_version_id
         FROM public.integration_plugins
        WHERE id = $1::uuid`,
      [install.installed_resource_id]
    );
    expect(pluginRows).toHaveLength(1);
    expect(pluginRows[0].status).toBe('active');
    expect(pluginRows[0].active_version_id).toBe(install.activation_result.plugin_version_id);

    const { rows: versionRows } = await client.query(
      `SELECT status, activated_at, activated_by
         FROM public.integration_plugin_versions
        WHERE id = $1::uuid`,
      [install.activation_result.plugin_version_id]
    );
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0].status).toBe('active');
    expect(versionRows[0].activated_at).toBeTruthy();
    expect(versionRows[0].activated_by).toBe(publisherUserId);
    const activeVersionId=install.activation_result.plugin_version_id;
    const oldHash=(await client.query('SELECT artifact_hash FROM public.integration_plugin_versions WHERE id=$1',[activeVersionId])).rows[0].artifact_hash;
    const source2=(await client.query("SELECT public.integration_plugin_generate_draft_v1('SG13 next source','webhook',p_source_payload:=$1::jsonb,p_workflow_binding:=jsonb_build_object('template_id',$2::uuid),p_plugin_id:=$3) AS result",[JSON.stringify({title:'Changed public source'}),templateId,plugin.pluginId])).rows[0].result;
    const next=(await client.query("SELECT public.automation_asset_create_listing_v1('integration_plugin',$1,NULL,NULL,'private',$2::jsonb,'{}','{}',NULL,$3) AS result",[source2.version_id,JSON.stringify(buildManifest()),listing.listing_id])).rows[0].result;
    await publishListingVersion(client,next.listing_version_id);
    const staged=(await client.query('SELECT public.automation_asset_upgrade_apply_v1($1,$2) AS result',[install.install_id,next.listing_version_id])).rows[0].result;
    expect(staged.runtime_activated).toBe(false);
    expect(staged.staged_plugin_version_id).toEqual(expect.any(String));
    const canonical=(await client.query('SELECT p.active_version_id,p.status,i.metadata FROM public.integration_plugins p JOIN public.automation_asset_installs i ON i.installed_resource_id=p.id WHERE i.id=$1',[install.install_id])).rows[0];
    expect(canonical.active_version_id).toBe(activeVersionId);
    expect(canonical.status).toBe('active');
    expect(canonical.metadata.pending_plugin_version_id).toBe(staged.staged_plugin_version_id);
    expect((await client.query('SELECT artifact_hash FROM public.integration_plugin_versions WHERE id=$1',[activeVersionId])).rows[0].artifact_hash).toBe(oldHash);
  });

  test('manifest validation rejects hardcoded secrets', async () => {
    const org = await createOrganization(client, `Marketplace Secret Validation Org ${Date.now()}`);
    const userId = await createUser(client, org.id, `secret-validation-${Date.now()}@example.com`, {
      userType: 'ops_admin',
    });
    await setAuthContext(client, userId);

    const workflowTemplateId = await createWorkflowTemplateDraft(client, `secret_validation_${randomUUID()}`);
    await mergeWorkflowStepMetadata(client, workflowTemplateId, {
      access_token: 'hardcoded-top-secret-token',
    });

    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_create_listing_v1($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
        [
          'workflow_template',
          workflowTemplateId,
          'Hardcoded secret listing',
          'should fail',
          'private',
          JSON.stringify(buildManifest()),
          JSON.stringify({}),
          JSON.stringify({}),
          'secret validation',
        ]
      ),
      /must not contain credentials|credential references/i
    );
  });

  test('manifest validation rejects unresolved placeholders, hardcoded scope ids, and invalid dependency contracts', async () => {
    const org = await createOrganization(client, `Marketplace Manifest Org ${Date.now()}`);
    const userId = await createUser(client, org.id, `manifest-validation-${Date.now()}@example.com`, {
      userType: 'ops_admin',
    });
    await setAuthContext(client, userId);

    const placeholderTemplateId = await createWorkflowTemplateDraft(client, `placeholder_${randomUUID()}`);
    await mergeWorkflowStepMetadata(client, placeholderTemplateId, {
      template: '{{var.missing_key}}',
    });
    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_create_listing_v1($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
        [
          'workflow_template',
          placeholderTemplateId,
          'Placeholder validation listing',
          'should fail',
          'private',
          JSON.stringify(buildManifest()),
          JSON.stringify({}),
          JSON.stringify({}),
          'placeholder validation',
        ]
      ),
      /not declared in manifest\.variable_schema/i
    );

    const scopeTemplateId = await createWorkflowTemplateDraft(client, `scope_${randomUUID()}`);
    await mergeWorkflowStepMetadata(client, scopeTemplateId, {
      owner_scope_id: org.id,
    });
    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_create_listing_v1($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
        [
          'workflow_template',
          scopeTemplateId,
          'Scope validation listing',
          'should fail',
          'private',
          JSON.stringify(buildManifest()),
          JSON.stringify({}),
          JSON.stringify({}),
          'scope validation',
        ]
      ),
      /hardcoded scope identifiers/i
    );

    const dependencyTemplateId = await createWorkflowTemplateDraft(client, `dependency_${randomUUID()}`);
    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_create_listing_v1($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
        [
          'workflow_template',
          dependencyTemplateId,
          'Dependency validation listing',
          'should fail',
          'private',
          JSON.stringify(
            buildManifest({
              dependency_requirements: {
                required_assets: [{}],
              },
            })
          ),
          JSON.stringify({}),
          JSON.stringify({}),
          'dependency validation',
        ]
      ),
      /required_assets entries must declare asset_kind/i
    );
  });

  test('install enforces required connection bindings and scope-local connection reuse', async () => {
    const org = await createOrganization(client, `Marketplace Install Org ${Date.now()}`);
    const clientRecord = await createClient(client, org.id, `Install Client ${Date.now()}`);
    const senderId = await createSender(client, clientRecord.id, `Install Sender ${Date.now()}`);
    const userId = await createUser(client, org.id, `install-validation-${Date.now()}@example.com`, {
      userType: 'ops_admin',
    });
    await setAuthContext(client, userId);

    const workflowTemplateId = await createWorkflowTemplateDraft(client, `install_${randomUUID()}`);
    const listing = await createListing(client, {
      sourceId: workflowTemplateId,
      manifest: buildManifest({
        connection_requirements: {
          bindings: [{ key: 'otp_provider' }],
        },
      }),
    });
    await publishListingVersion(client, listing.listing_version_id, 'private');

    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_install_v1($1::uuid, $2, $3::uuid, $4::jsonb, $5::jsonb, $6)`,
        [
          listing.listing_version_id,
          'tenant',
          org.id,
          JSON.stringify({}),
          JSON.stringify({}),
          false,
        ]
      ),
      /missing required connection binding otp_provider/i
    );

    const senderOwnedConnection = await createConnection(client, {
      ownerScopeType: 'sender',
      ownerScopeId: senderId,
      providerKey: `otp-sender-${Date.now()}`,
      name: 'Sender scoped OTP',
      authType: 'api_key',
      secretPayload: { secret: 'sender-secret-token' },
    });
    const tenantOwnedConnection = await createConnection(client, {
      ownerScopeType: 'tenant',
      ownerScopeId: org.id,
      providerKey: `otp-tenant-${Date.now()}`,
      name: 'Tenant scoped OTP',
      authType: 'api_key',
      secretPayload: { secret: 'tenant-secret-token' },
    });

    const install = await installListing(client, {
      listingVersionId: listing.listing_version_id,
      targetScopeType: 'tenant',
      targetScopeId: org.id,
      connectionBindings: {
        otp_provider: {
          connection_id: tenantOwnedConnection.connection_id,
        },
      },
    });
    expect(install.ok).toBe(true);
    const readBinding = async () => (await client.query(
      'SELECT to_jsonb(b) AS binding FROM public.automation_asset_install_bindings b WHERE install_id=$1',
      [install.install_id]
    )).rows[0].binding;
    const bindingBefore = await readBinding();

    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.integration_connection_bind_install_v1($1::uuid, $2, $3::uuid, $4, $5::jsonb)`,
        [install.install_id, 'otp_provider', senderOwnedConnection.connection_id, 'connection', JSON.stringify({})]
      ),
      /Materialized install bindings cannot change/i
    );

    const rotated = await client.query(
      `SELECT public.integration_connection_rotate_v1($1::uuid, $2::jsonb, $3, $4) AS result`,
      [tenantOwnedConnection.connection_id, JSON.stringify({ secret: 'tenant-secret-rotated' }), false, null]
    );
    expect(rotated.rows[0].result.status).toBe('ready');

    const revoked = await client.query(
      `SELECT public.integration_connection_revoke_v1($1::uuid, $2) AS result`,
      [tenantOwnedConnection.connection_id, '']
    );
    expect(revoked.rows[0].result.status).toBe('revoked');

    const { rows: revokedRows } = await client.query(
      `SELECT status, metadata
         FROM public.integration_connections
        WHERE id = $1::uuid`,
      [tenantOwnedConnection.connection_id]
    );
    expect(revokedRows[0].status).toBe('revoked');
    expect(revokedRows[0].metadata).toEqual(expect.any(Object));

    await expectPgError(
      client,
      () =>
        installListing(client, {
          listingVersionId: listing.listing_version_id,
          targetScopeType: 'tenant',
          targetScopeId: org.id,
          connectionBindings: {
            otp_provider: {
              connection_id: senderOwnedConnection.connection_id,
            },
          },
        }),
      /restricted to the install scope by policy/i
    );

    const confirmed = await client.query(
      `SELECT public.integration_connection_bind_install_v1($1::uuid, $2, $3::uuid, $4, $5::jsonb) AS result`,
      [install.install_id, 'otp_provider', tenantOwnedConnection.connection_id, 'connection', JSON.stringify({})]
    );
    expect(confirmed.rows[0].result).toMatchObject({ ok: true, noop: true });
    expect(await readBinding()).toEqual(bindingBefore);
    await expectPgError(client, () => installListing(client, {
      listingVersionId: listing.listing_version_id,
      targetScopeType: 'tenant',
      targetScopeId: org.id,
      connectionBindings: { otp_provider: { connection_id: tenantOwnedConnection.connection_id } },
    }), /Connection is not ready in target organization/i);
  });

  test('sender public publishing remains disabled by policy even when sender-scoped user has publish capability', async () => {
    const org = await createOrganization(client, `Marketplace Sender Policy Org ${Date.now()}`);
    const clientRecord = await createClient(client, org.id, `Sender Policy Client ${Date.now()}`);
    const senderId = await createSender(client, clientRecord.id, `Sender Policy Sender ${Date.now()}`);
    const senderUserId = await createUser(client, org.id, `sender-policy-${Date.now()}@example.com`, {
      userType: 'ops_admin',
      accessScopeType: 'sender',
      accessScopeId: senderId,
      provisionRbac: false,
    });
    await assignRoleTemplate(client, org.id, senderUserId, 'ops_admin');
    await upsertSettings(
      'automation_marketplace_policy',
      'tenant',
      org.id,
      {
        publication: {
          allow_sender_public_publish: false,
        },
      },
      'disable sender public publish',
      client
    );

    await setAuthContext(client, senderUserId);
    const senderWorkflowId = await createWorkflowTemplateDraft(
      client,
      `sender_public_${randomUUID()}`,
      'Sender-scoped marketplace template'
    );
    const listing = await createListing(client, {
      sourceId: senderWorkflowId,
      visibility: 'private',
    });

    const { rows: listingRows } = await client.query(
      `SELECT owner_scope_type, owner_scope_id
         FROM public.automation_asset_listings
        WHERE id = $1::uuid`,
      [listing.listing_id]
    );
    expect(listingRows[0].owner_scope_type).toBe('sender');
    expect(listingRows[0].owner_scope_id).toBe(senderId);

    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_submit_review_v1($1::uuid, $2)`,
        [listing.listing_version_id, 'sender public publish']
      ),
      /sender public publishing is disabled by policy/i
    );
  });

  test('OAuth is owner-configured and no generic secret getter or unbound result setter is restored', async () => {
    const org=await createOrganization(client,'SG13 default OAuth '+randomUUID());
    const user=await createUser(client,org.id,randomUUID()+'@example.invalid',{userType:'ops_admin'});
    const sessionId = randomUUID();
    await withFixtureAdminContext(client, async admin => {
      await admin.query(
        "INSERT INTO auth.users(id,aud,role,email) SELECT id,'authenticated','authenticated',email FROM public.users WHERE id=$1",
        [user]
      );
      await admin.query(
        "INSERT INTO auth.sessions(id,user_id,created_at,updated_at,aal,not_after) VALUES($1,$2,clock_timestamp(),clock_timestamp(),'aal1',clock_timestamp()+INTERVAL '1 hour')",
        [sessionId, user]
      );
    });
    await setAuthContext(client,user);
    const connection=await createConnection(client,{ownerScopeType:'tenant',ownerScopeId:org.id,providerKey:'unconfigured',name:'SG13 OAuth',authType:'oauth2_authorization_code_pkce'});
    await expectPgError(client, () => client.query('SELECT public.integration_connection_oauth_context_v1($1)', [connection.connection_id]), /OAuth authorization denied/);
    await setAuthContext(client,user,{session_id:sessionId});
    const {rows}=await client.query('SELECT public.integration_connection_oauth_context_v1($1) AS context',[connection.connection_id]);
    expect(rows[0].context.configured).toBe(false);
    const missing=await client.query("SELECT to_regprocedure('public.automation_marketplace_get_connection_secret_payload_v1(uuid)') AS getter,to_regprocedure('public.integration_connection_record_oauth_result_v1(uuid,jsonb,jsonb,text,timestamptz,text)') AS setter");
    expect(missing.rows[0]).toEqual({getter:null,setter:null});
  });

  test('upgrade preview rejects unknown targets and forked installs cannot be overwritten', async () => {
    const org = await createOrganization(client, `Marketplace Upgrade Org ${Date.now()}`);
    const userId = await createUser(client, org.id, `upgrade-${Date.now()}@example.com`, {
      userType: 'ops_admin',
    });
    await setAuthContext(client, userId);

    const workflowTemplateId = await createWorkflowTemplateDraft(client, `upgrade_${randomUUID()}`);
    const listing = await createListing(client, { sourceId: workflowTemplateId });
    await publishListingVersion(client, listing.listing_version_id, 'private');

    const install = await installListing(client, {
      listingVersionId: listing.listing_version_id,
      targetScopeType: 'tenant',
      targetScopeId: org.id,
    });
    expect(install.ok).toBe(true);

    const availability=async id=>(await client.query("SELECT public.ui_get_resource_v1('automation_asset_installs',$1) AS item",[id])).rows[0].item.upgrade_available;
    expect(await availability(install.install_id)).toBe(false);
    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_upgrade_preview_v1($1::uuid, $2::uuid)`,
        [install.install_id, randomUUID()]
      ),
      /target listing version not found/i
    );

    await client.query(
      'SELECT public.ui_create_workflow_template_step_v1($1::uuid, $2::jsonb)',
      [workflowTemplateId, JSON.stringify({
        operation_name: 'workflow_control',
        transition_condition: 'success',
        handler_key: 'workflow_control',
        enabled: true,
      })]
    );

    const nextListingVersionId = await createListingVersionFromCurrentWorkflow(client, {
      listingId: listing.listing_id,
      workflowTemplateId,
    });

    const { rows: previewRows } = await client.query(
      `SELECT public.automation_asset_upgrade_preview_v1($1::uuid, NULL) AS result`,
      [install.install_id]
    );
    expect(previewRows[0].result.ok).toBe(true);
    expect(previewRows[0].result.target_listing_version_id).toBe(nextListingVersionId);
    expect(previewRows[0].result.has_changes).toBe(true);
    expect(await availability(install.install_id)).toBe(true);
    const applied=await installListing(client,{listingVersionId:listing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id});
    await client.query('SELECT public.automation_asset_upgrade_apply_v1($1,$2)',[applied.install_id,nextListingVersionId]);
    expect(await availability(applied.install_id)).toBe(false);

    const { rows: forkRows } = await client.query(
      `SELECT public.automation_asset_fork_v1($1::uuid, $2) AS result`,
      [install.install_id, 'fork before applying upgrade']
    );
    expect(forkRows[0].result.ok).toBe(true);
    expect(await availability(install.install_id)).toBe(false);

    await expectPgError(
      client,
      () =>
        client.query(
        `SELECT public.automation_asset_upgrade_apply_v1($1::uuid, $2::uuid)`,
        [install.install_id, nextListingVersionId]
      ),
      /cannot overwrite a forked install/i
    );
  });

  test('materialized operation and workflow references must belong to the target scope', async () => {
    const org=await createOrganization(client,'SG13 refs A '+randomUUID());
    const foreign=await createOrganization(client,'SG13 refs B '+randomUUID());
    const user=await createUser(client,org.id,randomUUID()+'@example.invalid',{userType:'ops_admin'});
    const operations=await withFixtureAdminContext(client,async admin=>{
      const result=[];
      for(const organization of [org,foreign]){
        const provider=(await admin.query("INSERT INTO public.providers(organization_id,name,provider_type,enabled) VALUES($1,$2,'http',true) RETURNING id",[organization.id,'SG13 '+randomUUID()])).rows[0].id;
        const mapping = await createMappingConfig(admin, 'provider_response', 'sg13_'+randomUUID());
        await admin.query('UPDATE public.mapping_configs SET organization_id=$2 WHERE id=$1', [mapping, organization.id]);
        result.push((await admin.query("INSERT INTO public.operation_templates(provider_id,operation_name,handler_key,method,url_template,headers_template,body_template,metadata,mapping_config_id) VALUES($1,$2,'outbound_http','POST','https://example.invalid','{}','{}','{}',$3) RETURNING id",[provider,'sg13_'+randomUUID().replace(/-/g,''),mapping])).rows[0].id);
      }
      return result;
    });
    await setAuthContext(client,user);
    const workflow=await createWorkflowTemplateDraft(client,'sg13-ref-'+randomUUID());
    await mergeWorkflowStepMetadata(client,workflow,{operation_template_id:'{{var.selected}}'});
    const listing=await createListing(client,{sourceId:workflow,manifest:buildManifest({variable_schema:{keys:['selected']}})});
    await publishListingVersion(client,listing.listing_version_id);
    const error=await expectPgError(client,()=>installListing(client,{listingVersionId:listing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id,variableValues:{selected:operations[1]}}),/outside the install organization/);
    expect(error.code).toBe('42501');
    const installed=await installListing(client,{listingVersionId:listing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id,variableValues:{selected:operations[0]}});
    const {rows}=await client.query('SELECT metadata FROM public.workflow_template_steps WHERE workflow_template_id=$1',[installed.installed_resource_id]);
    expect(rows[0].metadata.operation_template_id).toBe(operations[0]);
    const foreignWorkflow=await withFixtureAdminContext(client,admin=>createWorkflowTemplate(admin,{name:'sg13-foreign-'+randomUUID(),scopeType:'tenant',scopeId:foreign.id,status:'active',transitionCondition:'success'}));
    await expectPgError(client,()=>client.query('SELECT public.automation_marketplace_assert_install_references_v1($1::jsonb,$2,$3,$3)',[JSON.stringify({version:{workflow_binding:{template_id:foreignWorkflow.templateId}}}),'tenant',org.id]),/permission denied/);
    // The helper is service-only; exercise the actual copy boundary with an authorized source/foreign resolved name.
    const source=(await client.query("SELECT public.integration_plugin_generate_draft_v1('SG13 workflow reference','api',p_workflow_binding:=$1::jsonb) AS result",[JSON.stringify({template_name:'{{var.selected}}'})])).rows[0].result;
    const pluginListing=await createListing(client,{assetKind:'integration_plugin',sourceId:source.version_id,manifest:buildManifest({variable_schema:{keys:['selected']}})});
    await publishListingVersion(client,pluginListing.listing_version_id);
    const foreignName=(await withFixtureAdminContext(client,admin=>admin.query('SELECT name FROM public.workflow_templates WHERE id=$1',[foreignWorkflow.templateId]))).rows[0].name;
    const denied=await expectPgError(client,()=>installListing(client,{listingVersionId:pluginListing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id,variableValues:{selected:foreignName}}),/outside the install scope/);
    expect(denied.code).toBe('42501');
  });

  test('Vault to verifier transition invalidates runtime credentials and rolls back atomically', async () => {
    const org=await createOrganization(client,'SG13 storage '+randomUUID());
    const user=await createUser(client,org.id,randomUUID()+'@example.invalid',{userType:'ops_admin'});
    const provider=await withFixtureAdminContext(client,async admin => (await admin.query("INSERT INTO public.providers(organization_id,name,provider_type,enabled) VALUES($1,$2,'http',true) RETURNING id",[org.id,'SG13 '+randomUUID()])).rows[0].id);
    await setAuthContext(client,user);
    const created=(await client.query("SELECT public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=$1,p_provider_id:=$2,p_name:='synthetic',p_secret_payload:=$3::jsonb) AS result",[org.id,provider,JSON.stringify({api_key:'sg13-vault-synthetic'})])).rows[0].result;
    const read=()=>withFixtureAdminContext(client,async admin=>(await admin.query('SELECT c.secret_storage_mode,c.credential_generation,a.credentials_vault_id AS runtime_vault,a.credentials AS runtime_credentials,a.expires_at FROM public.integration_connections c LEFT JOIN public.provider_auth_configs a ON a.id=c.runtime_auth_config_id WHERE c.id=$1',[created.connection_id])).rows[0]);
    const before=await read();
    expect(before.runtime_vault).toBeTruthy();
    await client.query('SAVEPOINT mode_transition');
    await client.query("SELECT public.integration_connection_upsert_v1(p_connection_id:=$1,p_secret_storage_mode:='hash_only',p_secret_payload:=$2::jsonb)",[created.connection_id,JSON.stringify({secret:'sg13-verifier-synthetic'})]);
    const changed=await read();
    expect(changed.secret_storage_mode).toBe('hash_only');
    expect(changed.runtime_vault).toBeNull();
    expect(changed.runtime_credentials).toEqual({});
    expect(Number(changed.credential_generation)).toBeGreaterThan(Number(before.credential_generation));
    const bindingManifest=buildManifest({connection_requirements:{bindings:[{key:'synthetic_provider'}]}});
    const bindingValues={synthetic_provider:{connection_id:created.connection_id}};
    const refs=await withFixtureAdminContext(client,async admin=>(await admin.query('SELECT public.automation_marketplace_sync_runtime_auth_config_v1($1) AS runtime_id,public.automation_marketplace_install_context_v1($2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$6) AS context',[created.connection_id,JSON.stringify(bindingManifest),'{}',JSON.stringify(bindingValues),'tenant',org.id])).rows[0]);
    expect(refs.runtime_id).toBeNull();
    expect(refs.context.conn.synthetic_provider.auth_config_id).toBeNull();
    const source=(await client.query("SELECT public.integration_plugin_generate_draft_v1('SG13 verifier reference','api',p_outbound_operations:=$1::jsonb) AS result",[JSON.stringify([{operation_name:'sg13',method:'POST',url_template:'https://example.invalid',auth:{mode:'api_key_header',header:'x-api-key',credential_key:'api_key',auth_config_id:'{{conn.synthetic_provider.auth_config_id}}'}}])])).rows[0].result;
    const listing=await createListing(client,{assetKind:'integration_plugin',sourceId:source.version_id,manifest:bindingManifest});
    await publishListingVersion(client,listing.listing_version_id);
    const unavailable=await expectPgError(client,()=>installListing(client,{listingVersionId:listing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id,connectionBindings:bindingValues,activate:true}),/^Activation requires resolved install values;/);
    expect(unavailable.code).toBe('23514');
    expect((await client.query('SELECT count(*)::int AS count FROM public.automation_asset_installs WHERE listing_id=$1',[listing.listing_id])).rows[0].count).toBe(0);
    await client.query('ROLLBACK TO SAVEPOINT mode_transition');
    const restored=await read();
    expect(restored.secret_storage_mode).toBe('vault');
    expect(restored.runtime_vault).toBe(before.runtime_vault);
    expect(restored.runtime_credentials).toEqual(before.runtime_credentials);
    expect(restored.credential_generation).toBe(before.credential_generation);
  });

  test('materialized binding confirmation is immutable and actual later activation requires current local evidence', async () => {
    const org=await createOrganization(client,'SG13 activation '+randomUUID());
    const user=await createUser(client,org.id,randomUUID()+'@example.invalid',{userType:'ops_admin'});
    const provider=await withFixtureAdminContext(client,async admin=>(await admin.query("INSERT INTO public.providers(organization_id,name,provider_type,enabled) VALUES($1,$2,'http',true) RETURNING id",[org.id,randomUUID()])).rows[0].id);
    await setAuthContext(client,user);
    const makeConnection=async name=>(await client.query("SELECT public.integration_connection_upsert_v1(p_owner_scope_type:='tenant',p_owner_scope_id:=$1,p_provider_id:=$2,p_name:=$3,p_secret_payload:=$4::jsonb) AS result",[org.id,provider,name,JSON.stringify({custom_key:'sg13-synthetic'})])).rows[0].result;
    const a=await makeConnection('A');
    const b=await makeConnection('B');
    const manifest=buildManifest({connection_requirements:{bindings:[{key:'provider'}]}});
    const bindings={provider:{connection_id:a.connection_id}};
    const source=await createWorkflowTemplateDraft(client,'sg13-activation-'+randomUUID());
    await mergeWorkflowStepMetadata(client,source,{auth:{auth_config_id:'{{conn.provider.auth_config_id}}'}});
    const listing=await createListing(client,{sourceId:source,manifest});
    await publishListingVersion(client,listing.listing_version_id);
    const copy=await installListing(client,{listingVersionId:listing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id,connectionBindings:bindings});
    const readBinding=async id=>(await client.query('SELECT to_jsonb(b) AS binding FROM public.automation_asset_install_bindings b WHERE install_id=$1',[id])).rows[0].binding;
    const before=await readBinding(copy.install_id);
    const confirm=(await client.query('SELECT public.integration_connection_bind_install_v1($1,$2,$3) AS result',[copy.install_id,'provider',a.connection_id])).rows[0].result;
    expect(confirm.noop).toBe(true);
    expect(await readBinding(copy.install_id)).toEqual(before);
    await expectPgError(client,()=>client.query('SELECT public.integration_connection_bind_install_v1($1,$2,$3)',[copy.install_id,'provider',b.connection_id]),/Materialized install bindings cannot change/);
    expect(await readBinding(copy.install_id)).toEqual(before);
    const activateWorkflow=()=>activateWorkflowTemplate(client,copy.installed_resource_id);
    await expectPgError(client,activateWorkflow,/current-generation credential-presence check/);
    const checked=(await client.query('SELECT public.integration_connection_test_v1($1) AS result',[a.connection_id])).rows[0].result;
    expect(checked).toMatchObject({ok:true,test_kind:'credential_presence',remote_verified:false});
    expect(checked.last_tested_credential_generation).toBe(checked.credential_generation);
    await activateWorkflow();
    const pluginSource=(await client.query("SELECT public.integration_plugin_generate_draft_v1('SG13 evidence','webhook',p_workflow_binding:=jsonb_build_object('template_id',$1::uuid),p_outbound_operations:=$2::jsonb) AS result",[copy.installed_resource_id,JSON.stringify([{operation_name:'sg13',method:'POST',url_template:'https://example.invalid',auth:{mode:'api_key_header',header:'x-api-key',credential_key:'custom_key',auth_config_id:'{{conn.provider.auth_config_id}}'}}])])).rows[0].result;
    const pluginListing=await createListing(client,{assetKind:'integration_plugin',sourceId:pluginSource.version_id,manifest});
    await publishListingVersion(client,pluginListing.listing_version_id);
    const pluginCopy=await installListing(client,{listingVersionId:pluginListing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id,connectionBindings:bindings});
    const version=(await client.query('SELECT id FROM public.integration_plugin_versions WHERE plugin_id=$1',[pluginCopy.installed_resource_id])).rows[0].id;
    await client.query("SELECT public.integration_plugin_submit_v1($1,'SG13 later activation proof')",[version]);
    await client.query("SELECT public.integration_plugin_approve_v1($1,'approved','SG13 later activation proof')",[version]);
    expect((await client.query('SELECT status FROM public.integration_plugin_versions WHERE id=$1 AND plugin_id=$2',[version,pluginCopy.installed_resource_id])).rows[0].status).toBe('approved');
    await client.query('SELECT public.integration_connection_rotate_v1($1,$2::jsonb)',[a.connection_id,JSON.stringify({custom_key:'sg13-new-synthetic'})]);
    await expectPgError(client,()=>client.query("SELECT public.integration_plugin_activate_v1($1,'tenant',$2)",[version,org.id]),/current-generation credential-presence check/);
    const stale=await expectPgError(client,()=>client.query("SELECT public.integration_plugin_activate_core_v1($1,'tenant',$2)",[version,org.id]),/current-generation credential-presence check/);
    expect(stale.code).toBe('23514');
    await client.query('SELECT public.integration_connection_test_v1($1)',[a.connection_id]);
    await client.query("SELECT public.integration_plugin_activate_v1($1,'tenant',$2)",[version,org.id]);
    const active=(await client.query('SELECT status,active_version_id FROM public.integration_plugins WHERE id=$1',[pluginCopy.installed_resource_id])).rows[0];
    expect(active).toEqual({status:'active',active_version_id:version});
    const operationHandlers=await withFixtureAdminContext(client,admin=>admin.query("SELECT o.handler_key FROM public.integration_plugin_bindings b JOIN public.operation_templates o ON o.id=b.runtime_resource_id WHERE b.plugin_version_id=$1 AND b.binding_type='operation_template' AND b.runtime_resource_type='operation_templates' ORDER BY o.id",[version]));
    expect(operationHandlers.rows.map(row=>row.handler_key)).toEqual(['outbound_http']);
    await expectPgError(client,()=>client.query('SELECT public.integration_connection_bind_install_v1($1,$2,$3)',[pluginCopy.install_id,'provider',b.connection_id]),/Materialized install bindings cannot change/);
    const executable=(await client.query('SELECT outbound_operations FROM public.integration_plugin_versions WHERE id=$1',[version])).rows[0].outbound_operations;
    expect(executable[0].auth.auth_config_id).toBe(before.runtime_resource_id);
    await client.query("SELECT public.integration_connection_upsert_v1(p_connection_id:=$1,p_config:=$2::jsonb)",[a.connection_id,JSON.stringify({endpoint:'https://example.invalid/changed'})]);
    await expectPgError(client,activateWorkflow,/current-generation credential-presence check/);
    await withFixtureAdminContext(client,async admin=>{
      const policy=(await admin.query("SELECT public.automation_marketplace_resolve_policy_v1('tenant',$1,$1) AS value",[org.id])).rows[0].value;
      policy.connections.require_test_before_activation=false;
      await upsertSettings('automation_marketplace_policy','tenant',org.id,policy,'Synthetic policy false',admin);
    });
    await activateWorkflow();
    await withFixtureAdminContext(client,admin=>admin.query("UPDATE public.integration_connections SET status='disabled' WHERE id=$1",[a.connection_id]));
    await expectPgError(client,activateWorkflow,/ready nonexpired connections/);
  });

  test('concurrent fork/upgrade and revoke/rotate serialize on actual lifecycle row locks', async () => {
    // Separate sessions require committed fixture rows; the unique owned organization is removed in finally.
    const org=await createOrganization(client,'SG13 concurrency '+randomUUID());
    const user=await createUser(client,org.id,randomUUID()+'@example.invalid',{userType:'ops_admin'});
    let other;
    let assertionError;
    try {
      await setAuthContext(client,user);
      const workflow=await createWorkflowTemplateDraft(client,'sg13-lock-'+randomUUID());
      const listing=await createListing(client,{sourceId:workflow});
      await publishListingVersion(client,listing.listing_version_id);
      const install=await installListing(client,{listingVersionId:listing.listing_version_id,targetScopeType:'tenant',targetScopeId:org.id});
      const connection=await createConnection(client,{ownerScopeType:'tenant',ownerScopeId:org.id,providerKey:'sg13-lock',name:'SG13 lock',secretPayload:{secret:'sg13-synthetic'}});
      await client.query('COMMIT');
      other=await pool.connect();
      await client.query('BEGIN');
      await setAuthContext(client,user);
      await client.query('SELECT public.automation_asset_fork_v1($1,NULL)',[install.install_id]);
      await other.query('BEGIN');
      await setAuthContext(other,user);
      await other.query("SET LOCAL lock_timeout='500ms'");
      await expect(other.query('SELECT public.automation_asset_upgrade_apply_v1($1,$2)',[install.install_id,listing.listing_version_id])).rejects.toMatchObject({code:'55P03'});
      await other.query('ROLLBACK');
      await client.query('COMMIT');
      await other.query('BEGIN');
      await setAuthContext(other,user);
      await expect(other.query('SELECT public.automation_asset_upgrade_apply_v1($1,$2)',[install.install_id,listing.listing_version_id])).rejects.toMatchObject({code:'P0001'});
      await other.query('ROLLBACK');

      await client.query('BEGIN');
      await setAuthContext(client,user);
      await client.query('SELECT public.integration_connection_revoke_v1($1,NULL)',[connection.connection_id]);
      await other.query('BEGIN');
      await setAuthContext(other,user);
      await other.query("SET LOCAL lock_timeout='500ms'");
      await expect(other.query('SELECT public.integration_connection_rotate_v1($1,$2::jsonb)',[connection.connection_id,JSON.stringify({secret:'sg13-new-synthetic'})])).rejects.toMatchObject({code:'55P03'});
      await other.query('ROLLBACK');
      await client.query('COMMIT');
      await other.query('BEGIN');
      await setAuthContext(other,user);
      await expect(other.query('SELECT public.integration_connection_rotate_v1($1,$2::jsonb)',[connection.connection_id,JSON.stringify({secret:'sg13-new-synthetic'})])).rejects.toMatchObject({code:'23514'});
      await other.query('ROLLBACK');
    } catch (error) {
      assertionError = error;
      throw error;
    } finally {
      try {
        if(other){try {await other.query('ROLLBACK');} finally {other.release();}}
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await setFixtureAdminContext(client);
        const { rows: secrets } = await client.query('SELECT credentials_vault_id FROM public.integration_connections WHERE organization_id=$1 AND credentials_vault_id IS NOT NULL', [org.id]);
        const secretIds = secrets.map(row => row.credentials_vault_id);
        await client.query('DELETE FROM public.automation_asset_installs WHERE organization_id=$1',[org.id]);
        await client.query('DELETE FROM public.automation_asset_listings WHERE organization_id=$1',[org.id]);
        await cleanupAutoOnboardingArtifacts(client, org.id);
        await client.query("DELETE FROM public.workflow_templates WHERE scope_type='tenant' AND scope_id=$1",[org.id]);
        await client.query("DELETE FROM public.settings WHERE scope_type='tenant' AND scope_id=$1",[org.id]);
        await client.query("DELETE FROM public.settings_versions WHERE scope_type='tenant' AND scope_id=$1",[org.id]);
        await client.query('DELETE FROM public.settings_resolution_log WHERE organization_id=$1',[org.id]);
        await client.query('DELETE FROM public.users WHERE id=$1 AND organization_id=$2',[user,org.id]);
        await client.query('DELETE FROM public.organizations WHERE id=$1',[org.id]);
        await client.query('DELETE FROM vault.secrets WHERE id=ANY($1::uuid[])', [secretIds]);
        const { rows: [remaining] } = await client.query(
          'SELECT EXISTS(SELECT 1 FROM public.organizations WHERE id=$1) OR EXISTS(SELECT 1 FROM public.users WHERE id=$2) OR EXISTS(SELECT 1 FROM vault.secrets WHERE id=ANY($3::uuid[])) AS owned_fixture_remains',
          [org.id, user, secretIds]
        );
        expect(remaining.owned_fixture_remains).toBe(false);
        await client.query('COMMIT');
        await client.query('BEGIN');
      } catch (cleanupError) {
        if (assertionError) throw new AggregateError([assertionError, cleanupError], 'Lifecycle assertion and fixture cleanup failed');
        throw cleanupError;
      }
    }
  });

});
