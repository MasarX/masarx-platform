const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');
const sql = read('supabase/migrations/20261020130001_organization_profile_branding_v1.sql');
const body = (name) => sql.slice(sql.indexOf(`FUNCTION public.${name}(`)).split('$function$;')[0];

describe('organization branding database and browser contract', () => {
  test('the private logo bucket permits every advertised raster format without changing its size limit', () => {
    const bucket = read('supabase/config.toml').split('[storage.buckets."label-render-assets"]')[1].split(/\r?\n\[/)[0];
    expect(bucket).toMatch(/^public = false$/m);
    expect(bucket).toMatch(/^file_size_limit = "10MiB"$/m);
    const allowed = JSON.parse(bucket.match(/^allowed_mime_types = (.+)$/m)[1]);
    expect(allowed).toEqual(expect.arrayContaining(['image/png', 'image/jpeg', 'image/webp']));
  });
  test('declares the checked Edge authentication entry consistently', () => {
    const entry = JSON.parse(read('config/edge/functions.json')).functions.find((item) => item.name === 'organization-profile');
    expect(entry).toMatchObject({ auth_mode: 'public_no_jwt', enabled: true });
    expect(JSON.parse(read('supabase/functions/organization-profile/deno.json')).deploy.verify_jwt).toBe(false);
  });
  test('every profile read/save reuses verified actor, capability and exact target scope', () => {
    const guard = body('organization_profile_assert_writer_v1');
    expect(guard).toContain('v_actor UUID := auth.uid()');
    expect(guard).toContain("id = v_actor AND status = 'active'");
    expect(guard).toContain("assert_capability_v1('organizations.write'");
    expect(guard).toContain("user_has_resource_capability_v1('organizations', 'write') IS NOT TRUE");
    expect(guard).toContain("public.current_user_scope_type() = 'tenant' AND p_organization_id = public.current_user_org_id()");
    expect(guard).toContain('public.is_platform_user()');
    expect(guard).toContain(') IS NOT TRUE THEN');
    for (const name of ['organization_profile_read_v1', 'ui_update_organization_profile_v1']) {
      expect(body(name)).toContain('public.organization_profile_assert_writer_v1(');
    }
  });
  test('edits only bounded profile fields and two branding colors, preserving unrelated defaults', () => {
    const update = body('ui_update_organization_profile_v1');
    expect(update).toContain('WHERE id = v_org FOR UPDATE');
    expect(update).toContain("v_branding := COALESCE(v_defaults->'branding', '{}'::jsonb)");
    expect(update).toContain("FOREACH v_key IN ARRAY ARRAY['primary_color','secondary_color']");
    expect(update).toContain("jsonb_typeof(p_args->v_key) IS DISTINCT FROM 'string'");
    expect(update).toContain("'^#[0-9A-Fa-f]{6}$'");
    expect(update).not.toContain('default_settings_patch');
    expect(update).not.toContain('v_defaults := v_defaults ||');
    expect(update).toContain('RETURN public.organization_profile_read_v1(v_org)');
  });
  test('read and signing expose only safe profile colors and validate the linked artifact identity, not a path prefix', () => {
    const read = body('organization_profile_read_v1');
    expect(read).toContain("'default_settings', jsonb_build_object('branding', jsonb_strip_nulls");
    expect(read).not.toContain("'default_settings', COALESCE(default_settings");
    for (const binding of ["a.created_by_user_id IS NOT NULL", 'u.id = a.created_by_user_id', "a.source_system = 'organization-profile'", "a.metadata->>'upload_id' ~", "a.metadata->>'file_name' ~", "a.sha256 ~", 'FROM storage.objects']) expect(read).toContain(binding);
    expect(read).toContain("a.storage_key = p_organization_id::text || '/branding/'");
    expect(read).not.toContain('storage_key LIKE');
  });
  test('does not accept caller-declared storage identity or another uploader artifact', () => {
    const update = body('ui_update_organization_profile_v1');
    expect(update).toContain('a.created_by_user_id = auth.uid()');
    expect(update).toContain("a.source_system = 'organization-profile'");
    expect(update).toContain("a.storage_bucket = 'label-render-assets'");
    expect(update).toContain('FROM storage.objects');
    expect(update).toContain("a.sha256 ~ '^[0-9a-f]{64}$' FOR UPDATE");
  });
  test('compensation is service-only and protects any saved profile or artifact link', () => {
    const abort = body('organization_profile_abort_upload_v1');
    for (const binding of ['p_artifact_id','p_organization_id','p_actor_user_id','p_upload_id','p_storage_key']) expect(abort).toContain(binding);
    expect(abort).toContain("auth.role() IS DISTINCT FROM 'service_role'");
    expect(abort).toContain("FROM public.organizations WHERE default_settings->'branding'->>'logo_artifact_id' = p_artifact_id::text");
    expect(abort).toContain("default_settings->'branding'->>'logo_storage_key' = p_storage_key");
    expect(abort).toContain("id <> p_artifact_id AND storage_bucket = 'label-render-assets' AND storage_key = p_storage_key");
    expect(abort).toContain('FROM public.artifact_links WHERE artifact_id = p_artifact_id');
    expect(abort).toContain('DELETE FROM public.artifacts WHERE id = p_artifact_id');
    expect(sql).toContain('api.organization_profile_abort_upload_v1(UUID,UUID,UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated');
    expect(sql).not.toMatch(/GRANT.*(?:TABLE|storage\.objects)/);
  });
  test('keeps the new surface inside the current organization detail footer', () => {
    const route = read('apps/console/app/resources/[resource]/page.tsx');
    expect(route).toContain('params.resource === "organizations"');
    expect(route).toContain('renderDetailFooter=');
    expect(route).toContain('<OrganizationProfileEditor organizationId={detailId}');
  });
  test('provides matching complete English and Arabic form messages', () => {
    const en = JSON.parse(read('packages/config/messages/en.json')).ui.organizationProfile;
    const ar = JSON.parse(read('packages/config/messages/ar.json')).ui.organizationProfile;
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const value of Object.values(ar)) expect(value).toMatch(/[\u0600-\u06ff]/);
  });
});
