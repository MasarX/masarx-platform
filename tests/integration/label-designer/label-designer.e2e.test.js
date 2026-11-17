const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { requireEnv } = require('../../utils/test-env');
const { getInvokeErrorBodyText, getInvokeErrorStatus, invokeFunctionWithRetry } = require('../helpers/http');
const {
  isAuthSignatureModeError,
  logAuthSignatureModeSkip,
} = require('../helpers/auth-signature-mode');
const { createUser } = require('../helpers/tenant-utils');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function skipForAuthSignatureMode(errorLike) {
  if (!isAuthSignatureModeError(errorLike)) {
    return false;
  }
  logAuthSignatureModeSkip('label-designer.e2e', errorLike);
  return true;
}

describe('Label designer (API E2E)', () => {
  const missing = requireEnv(
    ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    'label designer e2e',
  );

  afterAll(async () => {
    await pool.end().catch(() => {});
  });

  (missing ? test.skip : test)('draft -> validate -> preview -> assets -> publish', async () => {
    const service = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    );

    try {
      const { error: authProbeErr } = await service.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (authProbeErr && skipForAuthSignatureMode(authProbeErr)) {
        return;
      }
    } catch (error) {
      if (skipForAuthSignatureMode(error)) {
        return;
      }
    }

    const orgId = randomUUID();
    const clientId = randomUUID();
    const shipmentId = randomUUID();
    const boxId = randomUUID();
    const email = `ld-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const password = `T!${Math.random().toString(16).slice(2)}Aa1`;
    const labelType = 'shipping';

    let authUserId = null;
    let draftId = null;
    let uploadedPath = null;

    const db = await pool.connect();
    try {
      await db.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Label Designer Org', $2::text, 'Asia/Riyadh', 'ar-SA', 'active')`,
        [orgId, `ld-${orgId.slice(0, 8)}`],
      );

      await db.query(
        `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
         VALUES ($1::uuid, $2::uuid, 'Label Designer Client', $3::text, 'standard', 'active', '{}'::jsonb)`,
        [clientId, orgId, `ld-client-${clientId.slice(0, 8)}`],
      );

      const shipmentTracking = `LD${shipmentId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
      await db.query(
        `INSERT INTO shipments (id, organization_id, client_id, service_type, tracking_number, status, metadata, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'delivery', $4::text, 'pending', '{}'::jsonb, now(), now())`,
        [shipmentId, orgId, clientId, shipmentTracking],
      );

      await db.query(
        `INSERT INTO shipment_boxes (id, shipment_id, organization_id, client_id, box_number, barcode, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::text, now())`,
        [boxId, shipmentId, orgId, clientId, `${shipmentTracking}:1`],
      );

      const { data: authData, error: authErr } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (authErr || !authData?.user?.id) {
        if (skipForAuthSignatureMode(authErr || 'auth.admin.createUser missing user id')) return;
        throw new Error(`auth.admin.createUser failed: ${authErr?.message || 'missing user id'}`);
      }
      authUserId = authData.user.id;

      await createUser(db, orgId, email, {
        id: authUserId,
        fullName: 'Label Designer Tester',
        userType: 'ops_admin',
        status: 'active',
        accessScopeType: 'tenant',
      });

      const user = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        db: { schema: 'api' },
      });

      const { data: signInData, error: signInErr } = await user.auth.signInWithPassword({ email, password });
      if (signInErr || !signInData?.session?.access_token) {
        if (skipForAuthSignatureMode(signInErr || 'auth.signInWithPassword missing session')) return;
        throw new Error(`auth.signInWithPassword failed: ${signInErr?.message || 'missing session'}`);
      }
      const accessToken = signInData.session.access_token;
      const decodeJwtPayload = (token) => {
        try {
          const [, payload] = String(token || '').split('.');
          if (!payload) return null;
          const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
          const json = Buffer.from(padded, 'base64').toString('utf8');
          return JSON.parse(json);
        } catch {
          return null;
        }
      };
      const jwt = decodeJwtPayload(accessToken);
      if (!jwt || jwt.role !== 'authenticated' || jwt.sub !== authUserId) {
        throw new Error(`unexpected access token claims: ${JSON.stringify({ role: jwt?.role, sub: jwt?.sub })}`);
      }

      const { data: who, error: whoErr } = await user.rpc('label_designer_whoami').single();
      if (whoErr || !who || who.ok !== true) throw new Error(`whoami failed: ${whoErr?.message || JSON.stringify(who)}`);
      const effectiveOrgId = String(who.organization_id || '');
      if (!effectiveOrgId) throw new Error('whoami missing organization_id');
      if (who.can_write !== true) {
        throw new Error(`whoami missing label_design.write capability: ${JSON.stringify(who)}`);
      }

      const { data: mediaCatalog, error: mediaErr } = await user
        .rpc('label_designer_get_label_media_catalog', { p_scope_type: 'tenant', p_scope_id: effectiveOrgId })
        .single();
      if (mediaErr || !mediaCatalog || mediaCatalog.ok !== true) {
        throw new Error(`media catalog failed: ${mediaErr?.message || JSON.stringify(mediaCatalog)}`);
      }

      const { data: fields, error: fieldsErr } = await user
        .rpc('label_designer_get_field_catalog', { p_scope_type: 'tenant', p_scope_id: effectiveOrgId })
        .single();
      if (fieldsErr || !fields || fields.ok !== true) throw new Error(`field catalog failed: ${fieldsErr?.message}`);

      const { data: samplePayload, error: sampleErr } = await user
        .rpc('label_designer_get_sample_payload', { p_shipment_id: shipmentId, p_shipment_box_id: boxId })
        .single();
      if (sampleErr || !samplePayload || samplePayload.ok !== true) {
        throw new Error(`sample payload failed: ${sampleErr?.message || JSON.stringify(samplePayload)}`);
      }

      const findStringPath = (value, target, prefix = '') => {
        if (value === target) return prefix;
        if (!value || typeof value !== 'object') return null;
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 1) {
            const hit = findStringPath(value[i], target, prefix ? `${prefix}.${i}` : String(i));
            if (hit) return hit;
          }
          return null;
        }
        for (const [k, v] of Object.entries(value)) {
          const hit = findStringPath(v, target, prefix ? `${prefix}.${k}` : k);
          if (hit) return hit;
        }
        return null;
      };

      const payload = samplePayload.payload || {};
      const valuePath =
        findStringPath(payload, shipmentTracking) || findStringPath(payload, `${shipmentTracking}:1`) || null;
      if (!valuePath) throw new Error('sample payload missing a usable tracking value path');

      const [{ data: designResp, error: designErr }, { data: ppResp, error: ppErr }] = await Promise.all([
        user.rpc('label_designer_get_effective_label_design', { p_scope_type: 'tenant', p_scope_id: orgId }).single(),
        user.rpc('label_designer_get_effective_label_print_profile', { p_scope_type: 'tenant', p_scope_id: orgId }).single(),
      ]);
      if (designErr || !designResp || designResp.ok !== true) {
        throw new Error(`effective label_design failed: ${designErr?.message || JSON.stringify(designResp)}`);
      }
      if (ppErr || !ppResp || ppResp.ok !== true) {
        throw new Error(`effective label_print_profile failed: ${ppErr?.message || JSON.stringify(ppResp)}`);
      }

      const printProfile = ppResp.value || {};
      const media = printProfile.media || {};
      const widthInch = Number(media.width_inch || 4);
      const heightInch = Number(media.height_inch || 6);
      const dpi = Number(printProfile.dpi || 203);
      const profileKey = String(printProfile.profile_key || 'default_203dpi');

      const minimalTemplate = {
        version: '1.0.0',
        template_key: labelType,
        label_type: labelType,
        print_profile_key: profileKey,
        page: { width_inch: widthInch, height_inch: heightInch, dpi, orientation: 'portrait' },
        assets: [
          {
            name: 'missing_logo',
            path: `e2e/${orgId}/missing-logo-${Date.now()}.png`,
            content_type: 'image/png',
          },
        ],
        blocks: [
          {
            id: 'title_text',
            type: 'text',
            x: 24,
            y: 24,
            width: 240,
            height: 24,
            color: '#111827',
            font_size: 12,
            text_expr: { op: 'literal', value: 'Label Designer Preview' },
          },
          {
            id: 'code128_block',
            type: 'barcode',
            x: 24,
            y: 70,
            width: 220,
            height: 80,
            color: '#111827',
            barcode_type: 'code128',
            value_path: valuePath,
          },
          {
            id: 'qr_block',
            type: 'barcode',
            x: 160,
            y: 160,
            width: 100,
            height: 100,
            color: '#111827',
            barcode_type: 'qr',
            value_path: valuePath,
          },
          {
            id: 'missing_logo_block',
            type: 'image',
            x: 24,
            y: 280,
            width: 60,
            height: 30,
            asset_ref: 'missing_logo',
          },
        ],
      };

      const draftValue = { version: 'draft', templates: { [labelType]: minimalTemplate } };

      const { data: inserted, error: insertErr } = await user
        .from('label_design_drafts')
        .insert({
          organization_id: orgId,
          scope_type: 'tenant',
          scope_id: orgId,
          label_type: labelType,
          draft_name: 'E2E Draft',
          draft_value: draftValue,
          status: 'draft',
          created_by: authUserId,
        })
        .select('id')
        .single();
      if (insertErr || !inserted?.id) throw new Error(`draft insert failed: ${insertErr?.message}`);
      draftId = inserted.id;

      const { data: validation, error: validationErr } = await user
        .rpc('label_designer_validate_label_design_draft', { p_draft_id: draftId })
        .single();
      if (validationErr || !validation) throw new Error(`draft validation rpc failed: ${validationErr?.message}`);
      if (validation.ok !== true) throw new Error(`draft validation failed: ${JSON.stringify(validation)}`);

      const { data: preview, error: previewErr } = await invokeFunctionWithRetry(
        user,
        'label-renderer',
        {
          headers: {
            Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            apikey: process.env.SUPABASE_ANON_KEY,
          },
          body: {
            mode: 'designer_preview',
            user_jwt: accessToken,
            draft_id: draftId,
            label_type: labelType,
            shipment_id: shipmentId,
            shipment_box_id: boxId,
          },
        },
        { purpose: `designer preview ${draftId}` },
      );
      if (previewErr || !preview) {
        const status = getInvokeErrorStatus(previewErr) || null;
        const body = previewErr?.context?.body ?? null;
        const bodyText = getInvokeErrorBodyText(previewErr);
        if (skipForAuthSignatureMode({ message: previewErr?.message, status, body })) return;
        throw new Error(
          `preview failed: status=${status || 'unknown'} message=${previewErr?.message || 'unknown'} body=${bodyText}`,
        );
      }
      if (preview.ok !== true || typeof preview.pdf_base64 !== 'string' || preview.pdf_base64.length < 50) {
        throw new Error(`preview did not return a PDF: ${JSON.stringify(preview)}`);
      }

      const pngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PkS9GQAAAABJRU5ErkJggg==';
      const assetsHeaders = {
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        apikey: process.env.SUPABASE_ANON_KEY,
      };

      const { data: uploadRes, error: uploadResErr } = await invokeFunctionWithRetry(
        user,
        'label-designer-assets',
        {
          headers: assetsHeaders,
          body: {
            mode: 'upload',
            user_jwt: accessToken,
            file_name: 'e2e-pixel.png',
            content_type: 'image/png',
            file_base64: pngBase64,
          },
        },
        { purpose: `designer assets upload ${orgId}` },
      );
      if (uploadResErr || !uploadRes) {
        if (skipForAuthSignatureMode(uploadResErr || uploadRes || 'asset upload no response')) return;
        throw new Error(`asset upload failed: ${uploadResErr?.message || 'no response'}`);
      }
      if (uploadRes.ok !== true || typeof uploadRes.path !== 'string') {
        if (skipForAuthSignatureMode(uploadRes)) return;
        throw new Error(`asset upload not ok: ${JSON.stringify(uploadRes)}`);
      }
      uploadedPath = uploadRes.path;

      const { data: listRes, error: listResErr } = await invokeFunctionWithRetry(
        user,
        'label-designer-assets',
        {
          headers: assetsHeaders,
          body: { mode: 'list', user_jwt: accessToken },
        },
        { purpose: `designer assets list ${orgId}` },
      );
      if (listResErr || !listRes) {
        if (skipForAuthSignatureMode(listResErr || listRes || 'asset list no response')) return;
        throw new Error(`asset list failed: ${listResErr?.message || 'no response'}`);
      }
      if (listRes.ok !== true || !Array.isArray(listRes.assets)) {
        if (skipForAuthSignatureMode(listRes)) return;
        throw new Error(`asset list not ok: ${JSON.stringify(listRes)}`);
      }
      const found = listRes.assets.some((a) => a?.path === uploadedPath || a?.name === 'e2e-pixel.png');
      if (!found) throw new Error('uploaded asset not visible in assets list');

      const { data: signedRes, error: signedResErr } = await invokeFunctionWithRetry(
        user,
        'label-designer-assets',
        {
          headers: assetsHeaders,
          body: { mode: 'signed_url', user_jwt: accessToken, path: uploadedPath, expires_seconds: 30 },
        },
        { purpose: `designer assets signed_url ${orgId}` },
      );
      if (signedResErr || !signedRes) {
        if (skipForAuthSignatureMode(signedResErr || signedRes || 'signed url no response')) return;
        throw new Error(`signed url failed: ${signedResErr?.message || 'no response'}`);
      }
      if (signedRes.ok !== true || typeof signedRes.signed_url !== 'string') {
        if (skipForAuthSignatureMode(signedRes)) return;
        throw new Error(`signed url not ok: ${JSON.stringify(signedRes)}`);
      }

      const { data: publish, error: publishErr } = await user
        .rpc('label_designer_publish_label_design_draft', { p_draft_id: draftId, p_change_reason: 'e2e publish' })
        .single();
      if (publishErr || !publish) {
        if (skipForAuthSignatureMode(publishErr || publish || 'publish no response')) return;
        throw new Error(`publish failed: ${publishErr?.message || 'no response'}`);
      }
      if (publish.ok !== true) {
        if (skipForAuthSignatureMode(publish)) return;
        throw new Error(`publish not ok: ${JSON.stringify(publish)}`);
      }
    } finally {
      try {
        if (uploadedPath) {
          await service.storage.from('label-render-assets').remove([uploadedPath]).catch(() => {});
        }
      } catch {}

      try {
        if (draftId) {
          await db.query(`DELETE FROM public.label_design_drafts WHERE organization_id = $1::uuid AND id = $2::uuid`, [
            orgId,
            draftId,
          ]).catch(() => {});
        }
      } catch {}

      try {
        await db.query(`DELETE FROM public.settings WHERE scope_id = $1::uuid AND category IN ('label_design')`, [orgId]).catch(() => {});
        await db.query(`DELETE FROM public.settings_versions WHERE scope_id = $1::uuid AND category IN ('label_design')`, [orgId]).catch(() => {});
      } catch {}

      try {
        await db.query(`DELETE FROM public.shipment_boxes WHERE id = $1::uuid`, [boxId]).catch(() => {});
        await db.query(`DELETE FROM public.shipments WHERE id = $1::uuid`, [shipmentId]).catch(() => {});
      } catch {}

      try {
        if (authUserId) {
          await db.query(
            `DELETE FROM public.rbac_user_role_assignments WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
            [orgId, authUserId],
          ).catch(() => {});
        }
      } catch {}

      try {
        await db.query(`DELETE FROM public.users WHERE id = $1::uuid`, [authUserId]).catch(() => {});
      } catch {}

      try {
        await db.query(`DELETE FROM public.clients WHERE id = $1::uuid`, [clientId]).catch(() => {});
        await db.query(`DELETE FROM public.organizations WHERE id = $1::uuid`, [orgId]).catch(() => {});
      } catch {}

      try {
        await db.query(`DELETE FROM public.settings_resolution_log WHERE organization_id = $1::uuid`, [orgId]).catch(() => {});
        await db.query(`DELETE FROM public.decision_log WHERE organization_id = $1::uuid`, [orgId]).catch(() => {});
      } catch {}

      try {
        if (authUserId) {
          await service.auth.admin.deleteUser(authUserId).catch(() => {});
        }
      } catch {}

      db.release();
    }
  });
});
