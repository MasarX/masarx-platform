import { translateAdapterMessage } from '../i18n';
import {
  assertLabelDesignScope,
  backendOutcomeError,
  type CompleteLabelJobResult,
  type LabelDesignDraft,
  type LabelDesignerAsset,
  type LabelDesignerAssetListResult,
  type LabelDesignerAssetUploadArgs,
  type LabelDesignerAssetUploadResult,
  type LabelDesignerDraftListResult,
  type LabelDesignerDraftMutationResult,
  type LabelDesignerDraftPublishResult,
  type LabelDesignerDraftValidationResult,
  type LabelDesignerEffectiveConfigResult,
  type LabelDesignerFieldCatalogField,
  type LabelDesignerFieldCatalogResult,
  type LabelDesignerPreviewArgs,
  type LabelDesignerPreviewResult,
  type LabelDesignerSamplePayloadResult,
  type LabelDesignScopeType,
  type LabelPrinterCertificationArgs,
  type LabelPrinterCertificationResult,
  type LabelRendererReadinessResult,
  liveBackendUnavailableError,
  liveRpc,
  localLabelDesignDrafts,
  localLabelDesignerAssets,
  nextResourceId,
  objectRecord,
  phaseC6Rpc,
  readFunctionErrorMessage,
  requireLiveLabelDraftResult,
  requireLiveLabelPublishResult,
  requireLiveLabelValidationResult,
  requireLiveResourceListReadback,
  requireLiveResourceReadback,
  requireLiveRpcRecord,
  sleep,
  state,
  type TargetLabelRequestArgs,
  type TargetLabelRequestResult,
  ui_get_resource_v1,
} from '../data-source';
import { getSupabaseClient } from '../supabase';
import { asNonEmptyString } from './shared';
import { SEED_MODE_ENABLED } from '../seed-loader';

function localValidateLabelDesign(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [{ code: 'label_design_invalid', message: translateAdapterMessage('adapter.labelDesignInvalid') }];
  }
  const rec = value as Record<string, unknown>;
  const templates = rec.templates;
  if (!templates || typeof templates !== 'object' || Array.isArray(templates)) {
    return [{ code: 'templates_missing', message: translateAdapterMessage('adapter.labelTemplatesMissing') }];
  }
  const errors: Array<Record<string, unknown>> = [];
  for (const [templateKey, template] of Object.entries(templates as Record<string, unknown>)) {
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      errors.push({ code: 'template_invalid', message: translateAdapterMessage('adapter.labelTemplateInvalid'), template_key: templateKey });
      continue;
    }
    const t = template as Record<string, unknown>;
    if (!t.page || typeof t.page !== 'object' || Array.isArray(t.page)) {
      errors.push({ code: 'page_missing', message: translateAdapterMessage('adapter.labelPageMissing'), template_key: templateKey });
    }
    if (!Array.isArray(t.blocks)) {
      errors.push({ code: 'blocks_missing', message: translateAdapterMessage('adapter.labelBlocksMissing'), template_key: templateKey });
    }
  }
  return errors;
}

export async function label_designer_list_drafts(
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerDraftListResult> {
  assertLabelDesignScope(scopeType, scopeId);
  const live = await liveRpc<LabelDesignerDraftListResult>('label_designer_list_drafts', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'label_designer_list_drafts returned no backend draft list',
    );
    if (!Array.isArray(rec.drafts)) {
      throw new Error('label_designer_list_drafts did not return backend draft list evidence');
    }
    return {
      ...rec,
      ok: rec.ok !== false,
      drafts: rec.drafts as LabelDesignDraft[],
    };
  }

  await sleep(30);
  return {
    ok: true,
    drafts: localLabelDesignDrafts
      .filter((draft) => draft.scope_type === scopeType && draft.scope_id === scopeId)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
  };
}

export async function label_designer_get_field_catalog(
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerFieldCatalogResult> {
  assertLabelDesignScope(scopeType, scopeId);
  const live = await liveRpc<LabelDesignerFieldCatalogResult>('label_designer_get_field_catalog', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'label_designer_get_field_catalog returned no backend field catalog',
    );
    const value = rec.value && typeof rec.value === 'object' && !Array.isArray(rec.value)
      ? rec.value as Record<string, unknown>
      : {};
    const fields = Array.isArray(value.fields) ? value.fields as LabelDesignerFieldCatalogField[] : [];
    if (rec.ok !== false && fields.length === 0) {
      throw new Error('label_designer_get_field_catalog did not return backend field catalog evidence');
    }
    return {
      ...rec,
      ok: rec.ok !== false,
      value: {
        ...value,
        fields,
      },
    };
  }

  await sleep(30);
  return { ok: true, value: { version: 1, fields: [] } };
}

export async function ui_label_renderer_readiness_v1(
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelRendererReadinessResult> {
  assertLabelDesignScope(scopeType, scopeId);
  const live = await liveRpc<LabelRendererReadinessResult>('ui_label_renderer_readiness_v1', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'ui_label_renderer_readiness_v1 returned no backend readiness readback',
    );
    return { ...rec, ok: rec.ok !== false };
  }

  await sleep(30);
  return {
    ok: true,
    scope: { scope_type: scopeType, scope_id: scopeId },
    renderer_provider: {
      status: 'ready',
      provider_name: 'seed_renderer',
      invoke_url: 'http://127.0.0.1:54321/functions/v1/label-renderer',
      invoke_secret: 'redacted',
      timeout_ms: '15000',
    },
    render_policy: {
      status: 'ready',
      missing: [],
      value: { header_brand_mode: 'logo', arabic: { enabled: true }, barcode: { gate_mode: 'warn_only' } },
    },
    print_profile: {
      status: 'ready',
      missing: [],
      value: {
        profile_key: 'default_203dpi',
        dpi: 203,
        media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
      },
    },
    printer_certification: {
      status: 'missing',
      missing: ['printer_certification'],
      evidence: {},
    },
  };
}

export async function ui_record_label_printer_certification_v1(
  args: LabelPrinterCertificationArgs,
): Promise<LabelPrinterCertificationResult> {
  assertLabelDesignScope(args.scope_type, args.scope_id);
  const evidenceReference = asNonEmptyString(args.evidence_reference);
  const printerModel = asNonEmptyString(args.printer_model);
  if (!evidenceReference) throw new Error('evidence_reference is required');
  if (!printerModel) throw new Error('printer_model is required');
  const certification = {
    evidence_reference: evidenceReference,
    printer_model: printerModel,
    printer_serial: asNonEmptyString(args.printer_serial) ?? null,
    test_artifact_ref: asNonEmptyString(args.test_artifact_ref) ?? null,
    result: args.result ?? 'passed',
  };
  const live = await liveRpc<LabelPrinterCertificationResult>('ui_record_label_printer_certification_v1', {
    p_scope_type: args.scope_type,
    p_scope_id: args.scope_id,
    p_certification: certification,
    p_change_reason: asNonEmptyString(args.change_reason) ?? 'Recorded label printer certification from Console V2',
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'ui_record_label_printer_certification_v1 returned no backend certification readback',
    );
    if (rec.ok !== false && objectRecord(rec.readiness).printer_certification === undefined) {
      throw new Error('ui_record_label_printer_certification_v1 returned no backend readiness readback');
    }
    return {
      ...rec,
      ok: rec.ok !== false,
      readiness: objectRecord(rec.readiness) as LabelRendererReadinessResult,
      certification: objectRecord(rec.certification),
    };
  }

  await sleep(30);
  const seedCertificationId = `cert_${Date.now()}`;
  const readiness: LabelRendererReadinessResult = {
    ok: true,
    scope: { scope_type: args.scope_type, scope_id: args.scope_id },
    renderer_provider: {
      status: 'ready',
      provider_name: 'seed_renderer',
      invoke_url: 'http://127.0.0.1:54321/functions/v1/label-renderer',
      invoke_secret: 'redacted',
      timeout_ms: '15000',
    },
    render_policy: {
      status: 'ready',
      missing: [],
      value: { header_brand_mode: 'logo', arabic: { enabled: true }, barcode: { gate_mode: 'warn_only' } },
    },
    print_profile: {
      status: 'ready',
      missing: [],
      value: {
        profile_key: 'default_203dpi',
        dpi: 203,
        media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
        printer_certification: {
          certification_id: seedCertificationId,
          evidence_reference: evidenceReference,
          printer_model: printerModel,
          printer_serial: asNonEmptyString(args.printer_serial) ?? undefined,
          test_artifact_ref: asNonEmptyString(args.test_artifact_ref) ?? undefined,
          printer_dpi: 203,
          media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
          result: args.result ?? 'passed',
          source: 'console_v2_platform_labels',
        },
      },
    },
    printer_certification: {
      status: 'ready',
      missing: [],
      evidence: {
        certification_id: seedCertificationId,
        evidence_reference: evidenceReference,
        printer_model: printerModel,
        printer_serial: asNonEmptyString(args.printer_serial) ?? undefined,
        test_artifact_ref: asNonEmptyString(args.test_artifact_ref) ?? undefined,
        printer_dpi: 203,
        media: { kind: 'thermal', width_inch: 4, height_inch: 6 },
        result: args.result ?? 'passed',
        source: 'console_v2_platform_labels',
      },
    },
  };
  return {
    ok: true,
    scope_type: args.scope_type,
    scope_id: args.scope_id,
    settings_version_id: nextResourceId('settings_version'),
    settings_version_number: 1,
    certification: objectRecord(readiness.printer_certification?.evidence) as Record<string, unknown>,
    readiness,
  };
}

export async function label_designer_get_sample_payload(args: {
  shipment_id: string;
  shipment_box_id?: string | null;
}): Promise<LabelDesignerSamplePayloadResult> {
  const shipmentId = asNonEmptyString(args.shipment_id);
  if (!shipmentId) throw new Error('shipment_id is required');
  const live = await liveRpc<LabelDesignerSamplePayloadResult>('label_designer_get_sample_payload', {
    p_shipment_id: shipmentId,
    p_shipment_box_id: asNonEmptyString(args.shipment_box_id) ?? null,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'label_designer_get_sample_payload returned no backend payload',
    );
    if (rec.ok !== false && (!rec.payload || typeof rec.payload !== 'object')) {
      throw new Error('label_designer_get_sample_payload did not return backend payload evidence');
    }
    return {
      ...rec,
      ok: rec.ok !== false,
      payload: rec.payload && typeof rec.payload === 'object'
        ? rec.payload as Record<string, unknown>
        : undefined,
    };
  }

  await sleep(30);
  return {
    ok: true,
    payload: {
      shipment_id: shipmentId,
      shipment_box_id: asNonEmptyString(args.shipment_box_id) ?? null,
      tracking_number: 'SEED-LABEL-PREVIEW',
      recipient: { name: 'Seed Recipient' },
    },
  };
}

export async function label_designer_create_draft(args: {
  scope_type: LabelDesignScopeType;
  scope_id: string;
  label_type?: string;
  draft_name?: string | null;
  draft_value: Record<string, unknown>;
}): Promise<LabelDesignerDraftMutationResult> {
  assertLabelDesignScope(args.scope_type, args.scope_id);
  const live = await liveRpc<LabelDesignerDraftMutationResult>('label_designer_create_draft', {
    p_scope_type: args.scope_type,
    p_scope_id: args.scope_id,
    p_label_type: args.label_type ?? 'shipping',
    p_draft_name: args.draft_name ?? null,
    p_draft_value: args.draft_value,
  });
  if (live) {
    return requireLiveLabelDraftMutationReadback(
      requireLiveLabelDraftResult(live.data, 'label_designer_create_draft'),
      'label_designer_create_draft',
    );
  }

  await sleep(40);
  const now = new Date().toISOString();
  const draft: LabelDesignDraft = {
    id: nextResourceId('label_design_draft'),
    organization_id: args.scope_type === 'tenant' ? args.scope_id : (asNonEmptyString(state.user.organization_id) ?? null),
    scope_type: args.scope_type,
    scope_id: args.scope_id,
    label_type: args.label_type ?? 'shipping',
    draft_name: asNonEmptyString(args.draft_name) ?? null,
    draft_value: args.draft_value,
    status: 'draft',
    created_by: asNonEmptyString(state.user.id) ?? null,
    created_at: now,
    updated_at: now,
    published_settings_version_id: null,
    published_at: null,
  };
  localLabelDesignDrafts.unshift(draft);
  return { ok: true, draft };
}

export async function label_designer_update_draft(args: {
  draft_id: string;
  label_type?: string | null;
  draft_name?: string | null;
  draft_value?: Record<string, unknown> | null;
}): Promise<LabelDesignerDraftMutationResult> {
  const live = await liveRpc<LabelDesignerDraftMutationResult>('label_designer_update_draft', {
    p_draft_id: args.draft_id,
    p_label_type: args.label_type ?? null,
    p_draft_name: args.draft_name ?? null,
    p_draft_value: args.draft_value ?? null,
  });
  if (live) {
    return requireLiveLabelDraftMutationReadback(
      requireLiveLabelDraftResult(live.data, 'label_designer_update_draft'),
      'label_designer_update_draft',
    );
  }

  await sleep(40);
  const draft = localLabelDesignDrafts.find((row) => row.id === args.draft_id);
  if (!draft) return { ok: false, error: { code: 'draft_not_found', message: translateAdapterMessage('adapter.labelDraftNotFound') } };
  if (draft.status !== 'draft') return { ok: false, error: { code: 'draft_not_editable', message: translateAdapterMessage('adapter.labelDraftNotEditable') } };
  draft.label_type = args.label_type ?? draft.label_type;
  draft.draft_name = args.draft_name ?? draft.draft_name;
  draft.draft_value = args.draft_value ?? draft.draft_value;
  draft.updated_at = new Date().toISOString();
  return { ok: true, draft };
}

export async function label_designer_archive_draft(args: {
  draft_id: string;
  archive_reason?: string | null;
}): Promise<LabelDesignerDraftMutationResult> {
  const live = await liveRpc<LabelDesignerDraftMutationResult>('label_designer_archive_draft', {
    p_draft_id: args.draft_id,
    p_archive_reason: args.archive_reason ?? null,
  });
  if (live) {
    const result = await requireLiveLabelDraftMutationReadback(
      requireLiveLabelDraftResult(live.data, 'label_designer_archive_draft'),
      'label_designer_archive_draft',
    );
    if (result.ok !== false && result.draft?.status !== 'archived') {
      throw new Error('label_designer_archive_draft backend draft list readback is not archived');
    }
    return result;
  }

  await sleep(40);
  const draft = localLabelDesignDrafts.find((row) => row.id === args.draft_id);
  if (!draft) return { ok: false, error: { code: 'draft_not_found', message: translateAdapterMessage('adapter.labelDraftNotFound') } };
  if (draft.status !== 'draft') {
    return { ok: false, error: { code: 'draft_not_archivable', message: translateAdapterMessage('adapter.labelDraftNotArchivable') } };
  }
  const now = new Date().toISOString();
  draft.status = 'archived';
  draft.archived_at = now;
  draft.archived_by = asNonEmptyString(state.user.id) ?? null;
  draft.archive_reason = asNonEmptyString(args.archive_reason) ?? 'Archived from Console V2 Labels';
  draft.updated_at = now;
  return { ok: true, draft };
}

export async function label_designer_validate_label_design_draft(
  draftId: string,
): Promise<LabelDesignerDraftValidationResult> {
  const live = await liveRpc<LabelDesignerDraftValidationResult>('label_designer_validate_label_design_draft', {
    p_draft_id: draftId,
  });
  if (live) return requireLiveLabelValidationResult(live.data);

  await sleep(30);
  const draft = localLabelDesignDrafts.find((row) => row.id === draftId);
  if (!draft) {
    return {
      ok: false,
      errors: [],
      error: { code: 'draft_not_found', message: translateAdapterMessage('adapter.labelDraftNotFound') },
    };
  }
  const errors = localValidateLabelDesign(draft.draft_value);
  return { ok: errors.length === 0, errors };
}

export async function label_designer_publish_label_design_draft(
  draftId: string,
  changeReason?: string | null,
  readbackScope?: { scopeType?: string | null; scopeId?: string | null },
): Promise<LabelDesignerDraftPublishResult> {
  const live = await liveRpc<LabelDesignerDraftPublishResult>('label_designer_publish_label_design_draft', {
    p_draft_id: draftId,
    p_change_reason: changeReason ?? null,
  });
  if (live) {
    const result = requireLiveLabelPublishResult(live.data);
    if (result.ok !== false) {
      await requirePublishedLabelDraftReadback(draftId, result, readbackScope);
    }
    return result;
  }

  await sleep(50);
  const draft = localLabelDesignDrafts.find((row) => row.id === draftId);
  if (!draft) return { ok: false, error: { code: 'draft_not_found', message: translateAdapterMessage('adapter.labelDraftNotFound') } };
  const errors = localValidateLabelDesign(draft.draft_value);
  if (errors.length > 0) {
    return {
      ok: false,
      error: { code: 'validation_failed', message: translateAdapterMessage('adapter.labelDraftValidationFailed') },
      validation_errors: errors,
    };
  }
  const now = new Date().toISOString();
  draft.status = 'published';
  draft.published_at = now;
  draft.updated_at = now;
  draft.published_settings_version_id = nextResourceId('settings_version');
  return {
    ok: true,
    settings_version_id: draft.published_settings_version_id,
    scope_type: draft.scope_type,
    scope_id: draft.scope_id,
    schema_version: 1,
    version: localLabelDesignDrafts.filter((row) => row.scope_type === draft.scope_type && row.scope_id === draft.scope_id && row.status === 'published').length,
  };
}

async function requirePublishedLabelDraftReadback(
  draftId: string,
  result: LabelDesignerDraftPublishResult,
  readbackScope?: { scopeType?: string | null; scopeId?: string | null },
): Promise<void> {
  const scopeType = asNonEmptyString(readbackScope?.scopeType) ?? asNonEmptyString(result.scope_type);
  const scopeId = asNonEmptyString(readbackScope?.scopeId) ?? asNonEmptyString(result.scope_id);
  if (!scopeType || !scopeId) {
    throw new Error('label_designer_publish_label_design_draft did not return scope for published draft readback');
  }

  const live = await liveRpc<LabelDesignerDraftListResult>('label_designer_list_drafts', {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (!live) return;

  const list = requireLiveRpcRecord(
    live.data,
    'label_designer_publish_label_design_draft published draft readback returned no backend draft list',
  );
  const drafts = Array.isArray(list.drafts) ? list.drafts as LabelDesignDraft[] : [];
  const draft = drafts.find((row) => row.id === draftId);
  if (!draft) {
    throw new Error('label_designer_publish_label_design_draft published draft readback missing draft');
  }
  if (draft.status !== 'published') {
    throw new Error('label_designer_publish_label_design_draft published draft readback is not published');
  }
  const expectedVersion =
    asNonEmptyString(result.settings_version_id) ??
    asNonEmptyString(result.settings_resolution_id) ??
    asNonEmptyString(result.published_settings_version_id);
  const actualVersion = asNonEmptyString(draft.published_settings_version_id);
  if (expectedVersion && actualVersion && expectedVersion !== actualVersion) {
    throw new Error('label_designer_publish_label_design_draft published draft readback version mismatch');
  }
}

async function currentSupabaseAccessToken(client: NonNullable<ReturnType<typeof getSupabaseClient>>): Promise<string> {
  const auth = (client as unknown as {
    auth?: { getSession?: () => Promise<{ data?: { session?: { access_token?: string | null } | null } | null }> };
  }).auth;
  if (typeof auth?.getSession !== 'function') throw new Error('Supabase auth session is required');
  const { data } = await auth.getSession();
  const token = asNonEmptyString(data?.session?.access_token);
  if (!token) throw new Error('Sign in again to manage label designer assets');
  return token;
}

async function invokeLabelDesignerAssets<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<T | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  const userJwt = await currentSupabaseAccessToken(client);
  const { data, error } = await client.functions.invoke<T>('label-designer-assets', {
    body: {
      ...body,
      user_jwt: userJwt,
    },
  });
  if (error) throw new Error(await readFunctionErrorMessage(error, 'label designer asset request failed'));
  const rec = data && typeof data === 'object' ? data as T : null;
  if (!rec) throw new Error('label-designer-assets returned no backend response');
  const outcomeError = backendOutcomeError(rec, 'label designer asset request was rejected by the backend');
  if (outcomeError) throw outcomeError;
  return rec;
}

export async function label_designer_list_assets(): Promise<LabelDesignerAssetListResult> {
  const live = await invokeLabelDesignerAssets<LabelDesignerAssetListResult>({ mode: 'list' });
  if (live) {
    const assets = Array.isArray(live.assets)
      ? live.assets.filter((asset): asset is LabelDesignerAsset =>
        !!asset && typeof asset === 'object' && !!asNonEmptyString((asset as Record<string, unknown>).path),
      )
      : [];
    return { ...live, ok: live.ok !== false, assets };
  }

  await sleep(30);
  return { ok: true, assets: [...localLabelDesignerAssets] };
}

export async function label_designer_upload_asset(
  args: LabelDesignerAssetUploadArgs,
): Promise<LabelDesignerAssetUploadResult> {
  const fileName = asNonEmptyString(args.file_name);
  const fileBase64 = asNonEmptyString(args.file_base64);
  if (!fileName) throw new Error('Asset file name is required');
  if (!fileBase64) throw new Error('Asset file data is required');
  const live = await invokeLabelDesignerAssets<LabelDesignerAssetUploadResult>({
    mode: 'upload',
    file_name: fileName,
    file_base64: fileBase64,
    content_type: asNonEmptyString(args.content_type) ?? 'application/octet-stream',
  });
  if (live) {
    const path = asNonEmptyString(live.path);
    if (!path) throw new Error('label-designer-assets upload returned no storage path');
    const list = await label_designer_list_assets();
    if (!list.assets.some((asset) => asset.path === path)) {
      throw new Error('label-designer-assets upload readback missing uploaded asset');
    }
    return { ...live, ok: live.ok !== false, path };
  }

  await sleep(40);
  const safeName = fileName.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 120);
  const path = `local/designer/${safeName || nextResourceId('label_asset')}`;
  const existing = localLabelDesignerAssets.findIndex((asset) => asset.path === path);
  const asset = { name: safeName, path };
  if (existing >= 0) localLabelDesignerAssets[existing] = asset;
  else localLabelDesignerAssets.unshift(asset);
  return { ok: true, path };
}

export async function label_designer_delete_asset(
  path: string,
): Promise<{ ok: boolean; path?: string; error?: Record<string, unknown> }> {
  const assetPath = asNonEmptyString(path);
  if (!assetPath) throw new Error('Asset path is required');
  const live = await invokeLabelDesignerAssets<{ ok: boolean; path?: string; error?: Record<string, unknown> }>({
    mode: 'delete',
    path: assetPath,
  });
  if (live) {
    const list = await label_designer_list_assets();
    if (list.assets.some((asset) => asset.path === assetPath)) {
      throw new Error('label-designer-assets delete readback still contains deleted asset');
    }
    return { ...live, ok: live.ok !== false, path: assetPath };
  }

  await sleep(30);
  const idx = localLabelDesignerAssets.findIndex((asset) => asset.path === assetPath);
  if (idx >= 0) localLabelDesignerAssets.splice(idx, 1);
  return { ok: true, path: assetPath };
}

export async function label_designer_preview_label_design_draft(
  args: LabelDesignerPreviewArgs,
): Promise<LabelDesignerPreviewResult> {
  const draftId = asNonEmptyString(args.draft_id);
  const shipmentId = asNonEmptyString(args.shipment_id);
  if (!draftId) throw new Error('draft_id is required');
  if (!shipmentId) throw new Error('shipment_id is required');

  const client = getSupabaseClient();
  if (client) {
    const userJwt = await currentSupabaseAccessToken(client);
    const { data, error } = await client.functions.invoke<LabelDesignerPreviewResult>('label-renderer', {
      body: {
        mode: 'designer_preview',
        user_jwt: userJwt,
        draft_id: draftId,
        label_type: asNonEmptyString(args.label_type) ?? 'shipping',
        shipment_id: shipmentId,
        shipment_box_id: asNonEmptyString(args.shipment_box_id) ?? null,
      },
    });
    if (error) throw new Error(await readFunctionErrorMessage(error, 'label designer preview failed'));
    const rec = data && typeof data === 'object' ? data as LabelDesignerPreviewResult : null;
    if (!rec) throw new Error('label-renderer designer preview returned no backend response');
    if (rec.ok !== false && !asNonEmptyString(rec.pdf_base64)) {
      throw new Error('label-renderer designer preview returned no PDF readback');
    }
    return { ...rec, ok: rec.ok !== false };
  }

  await sleep(40);
  return {
    ok: true,
    pdf_base64: 'JVBERi0xLjQKJcTl8uXrp/Og0MTGCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+CmVuZG9iago=',
    renderer_metadata: {
      preview: true,
      draft_id: draftId,
      shipment_id: shipmentId,
    },
    validation: { ok: true, errors: [] },
  };
}

async function requireLabelReprintReadback(
  labelId: string,
  ids: { versionId?: string | null; jobId?: string | null; backendId?: string | null },
): Promise<void> {
  const candidates: Array<{ resource: 'label_versions' | 'label_jobs'; id: string }> = [];
  const pushCandidate = (resource: 'label_versions' | 'label_jobs', id?: string | null) => {
    const normalized = asNonEmptyString(id);
    if (!normalized) return;
    if (candidates.some((candidate) => candidate.resource === resource && candidate.id === normalized)) return;
    candidates.push({ resource, id: normalized });
  };

  pushCandidate('label_versions', ids.versionId);
  pushCandidate('label_jobs', ids.jobId);
  pushCandidate('label_versions', ids.backendId);
  pushCandidate('label_jobs', ids.backendId);

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const row = await ui_get_resource_v1<Record<string, unknown>>(candidate.resource, candidate.id);
      if (!row) continue;
      const rowLabelId = asNonEmptyString(row.label_id);
      if (rowLabelId && rowLabelId !== labelId) {
        throw new Error(`Label reprint ${candidate.resource} readback belongs to ${rowLabelId}, expected ${labelId}`);
      }
      const metadata = objectRecord(row.target_metadata);
      const sourceArtifactId =
        asNonEmptyString(metadata.source_label_artifact_id) ??
        asNonEmptyString(metadata.label_artifact_id);
      if (!rowLabelId && sourceArtifactId && sourceArtifactId !== labelId) {
        throw new Error(`Label reprint ${candidate.resource} readback belongs to artifact ${sourceArtifactId}, expected ${labelId}`);
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }

  const suffix = lastError instanceof Error && lastError.message ? `: ${lastError.message}` : '';
  throw new Error(`Label reprint backend readback missing label_jobs or label_versions${suffix}`);
}

// W54-F — typed adapter for the canonical complete_label_job seam. Live mode
// routes through `phaseC6Rpc('complete_label_job', payload, 'label_jobs')`;
// the in-memory branch returns a deterministic envelope so unit tests can
// assert on the FE-shaped contract without an environment dependency.
export async function request_label_reprint(
  labelId: string,
  { reason }: { reason: string },
): Promise<{
  ok: true;
  label_id: string;
  reason: string;
  label_job_id?: string | null;
  new_version_id?: string | null;
}> {
  const live = await liveRpc<unknown>('request_label_reprint', {
    p_label_id: labelId,
    p_reprint_reason: reason,
    p_actor_id: null,
    p_requested_source: 'console-v2',
  });
  if (live) {
    const rec = live.data && typeof live.data === 'object'
      ? live.data as Record<string, unknown>
      : null;
    const labelJobId =
      asNonEmptyString(live.data) ??
      asNonEmptyString(rec?.label_job_id) ??
      asNonEmptyString(rec?.job_id) ??
      asNonEmptyString(rec?.id);
    const labelVersionId =
      asNonEmptyString(rec?.new_version_id) ??
      asNonEmptyString(rec?.label_version_id);
    const evidenceId = labelJobId ?? labelVersionId;
    if (!evidenceId) {
      throw new Error('Label reprint did not return a label job or version id');
    }
    await requireLabelReprintReadback(labelId, {
      versionId: labelVersionId,
      jobId: labelJobId,
      backendId: evidenceId,
    });
    return {
      ok: true,
      label_id: labelId,
      reason,
      label_job_id: labelJobId ?? null,
      new_version_id: labelVersionId ?? null,
    };
  }

  await sleep(120);
  return { ok: true, label_id: labelId, reason, label_job_id: 'ljob_' + Date.now(), new_version_id: null };
}

export async function requireLiveCompleteLabelJobReadback(
  jobId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const labelJobId = asNonEmptyString(result.label_job_id) ?? asNonEmptyString(result.job_id) ?? jobId;
  const job = await requireLiveResourceReadback('label_jobs', labelJobId, 'complete_label_job');
  const status = (asNonEmptyString(job.status) ?? asNonEmptyString(result.status) ?? '').toLowerCase();
  const labelId = asNonEmptyString(job.label_id) ?? asNonEmptyString(result.label_id);
  const shipmentId = asNonEmptyString(job.shipment_id);
  const targetType = asNonEmptyString(job.target_type);

  if (!['completed', 'succeeded', 'success'].includes(status)) return;
  if (!labelId) {
    throw new Error('complete_label_job backend readback missing label identity');
  }

  if (shipmentId) {
    await requireLiveResourceReadback('labels', labelId, 'complete_label_job');
    await requireLiveResourceListReadback('label_versions', { label_job_id: labelJobId }, 'complete_label_job');
    return;
  }

  if (targetType) {
    await requireLiveResourceReadback('label_artifacts', labelId, 'complete_label_job');
  }
}

export async function requireLiveLabelDraftMutationReadback(
  result: LabelDesignerDraftMutationResult,
  rpcName: string,
): Promise<LabelDesignerDraftMutationResult> {
  if (result.ok === false) return result;
  const draft = result.draft;
  const draftId = asNonEmptyString(draft?.id) ?? asNonEmptyString(result.draft_id);
  const scopeType = draft?.scope_type;
  const scopeId = asNonEmptyString(draft?.scope_id);
  if (!draftId || !scopeType || !scopeId) {
    throw new Error(`${rpcName} did not return draft scope for backend readback`);
  }
  const readback = await label_designer_list_drafts(scopeType, scopeId);
  const readbackDraft = readback.drafts.find((row) => row.id === draftId);
  if (!readbackDraft) {
    throw new Error(`${rpcName} backend draft list readback missing draft`);
  }
  return { ...result, draft: readbackDraft };
}

async function labelDesignerEffectiveConfigRpc(
  rpcName: string,
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> {
  assertLabelDesignScope(scopeType, scopeId);
  const live = await liveRpc<LabelDesignerEffectiveConfigResult>(rpcName, {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      `${rpcName} returned no backend effective config`,
    );
    const value = rec.value && typeof rec.value === 'object' && !Array.isArray(rec.value)
      ? rec.value as Record<string, unknown>
      : {};
    return { ...rec, ok: rec.ok !== false, value };
  }

  await sleep(30);
  return { ok: true, value: {} };
}

export const label_designer_get_effective_label_design = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  labelDesignerEffectiveConfigRpc('label_designer_get_effective_label_design', scopeType, scopeId);

export const label_designer_get_effective_label_render_policy = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  labelDesignerEffectiveConfigRpc('label_designer_get_effective_label_render_policy', scopeType, scopeId);

export const label_designer_get_effective_label_print_profile = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  labelDesignerEffectiveConfigRpc('label_designer_get_effective_label_print_profile', scopeType, scopeId);

export const label_designer_get_label_media_catalog = (
  scopeType: LabelDesignScopeType,
  scopeId: string,
): Promise<LabelDesignerEffectiveConfigResult> =>
  labelDesignerEffectiveConfigRpc('label_designer_get_label_media_catalog', scopeType, scopeId);

export async function ui_request_label_generation_target_v1(
  args: TargetLabelRequestArgs,
): Promise<TargetLabelRequestResult> {
  const targetId = asNonEmptyString(args.target_id);
  const targetType = asNonEmptyString(args.target_type);
  if (!targetType) throw new Error('Target label type is required');
  if (!targetId) throw new Error('Target label id is required');

  const client = getSupabaseClient();
  if (client) {
    const result = await phaseC6Rpc('ui_request_label_generation_target_v1', {
      ...args,
      target_type: targetType,
      target_id: targetId,
      requested_source: asNonEmptyString(args.requested_source) ?? 'console-v2',
    }, 'label_job');
    const labelJobId =
      asNonEmptyString(result.label_job_id) ??
      asNonEmptyString(result.id) ??
      asNonEmptyString((result.job as Record<string, unknown> | undefined)?.id);
    if (!labelJobId) throw new Error('Target label request did not return a label job id');

    const job = await requireLiveResourceReadback('label_jobs', labelJobId, 'ui_request_label_generation_target_v1');
    const readbackTargetId = asNonEmptyString(job.target_id);
    const readbackTargetType = asNonEmptyString(job.target_type);
    if (readbackTargetId !== targetId) {
      throw new Error(`Target label job readback belongs to ${readbackTargetId ?? 'unknown'}, expected ${targetId}`);
    }
    if (!readbackTargetType) {
      throw new Error('Target label job readback missing target_type');
    }

    return {
      ok: true,
      label_job_id: labelJobId,
      target_type: readbackTargetType,
      target_id: readbackTargetId,
      target_box_id: asNonEmptyString(job.target_box_id),
      label_type: asNonEmptyString(job.label_type),
      status: asNonEmptyString(job.status),
      job,
      ...result,
    } as TargetLabelRequestResult;
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('ui_request_label_generation_target_v1');
  await sleep(80);
  return {
    ok: true,
    label_job_id: 'ljob_target_' + Date.now(),
    target_type: targetType,
    target_id: targetId,
    target_box_id: asNonEmptyString(args.target_box_id),
    label_type: asNonEmptyString(args.label_type) ?? null,
    status: 'pending',
    job: null,
  };
}

export async function complete_label_job(
  jobId: string,
  payload: unknown,
): Promise<CompleteLabelJobResult> {
  const args = { label_job_id: jobId, ...(payload as Record<string, unknown> | undefined) };
  const client = getSupabaseClient();
  if (client) {
    const result = await phaseC6Rpc('complete_label_job', args, 'label_jobs');
    await requireLiveCompleteLabelJobReadback(jobId, result);
    return result as CompleteLabelJobResult;
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('complete_label_job');
  await sleep(80);
  return {
    ok: true,
    label_job_id: jobId,
    status: 'completed',
    correlation_id: 'corr_' + Date.now(),
  };
}
