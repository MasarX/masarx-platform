import { useEffect, useMemo, useState, type DragEvent as ReactDragEvent } from 'react';
import { createUiTranslator } from '@masarx/ui/i18n';
import { DraftWorkflow } from '@masarx/ui/label-designer/draft-workflow';
import { PreviewPanel } from '@masarx/ui/label-designer/preview-panel';
import type { DraftRow, ShipmentBoxOption, ShipmentOption } from '@masarx/ui/label-designer/types';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import { pushToast } from '@/components/toastStore';
import type { LabelDesignDraft, LabelDesignScopeType } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import {
  useCreateLabelDesignDraft,
  useDeleteLabelDesignerAsset,
  useLabelDesignerAssets,
  useLabelDesignerEffectiveConfig,
  useLabelDesignerFieldCatalog,
  useLabelDesignerSamplePayload,
  usePreviewLabelDesignDraft,
  usePublishLabelDesignDraft,
  useResourceList,
  useUpdateLabelDesignDraft,
  useUploadLabelDesignerAsset,
  useValidateLabelDesignDraft,
} from '@/lib/queries';
import {
  type LabelSpec,
  type LabelTypeOption,
  nonEmptyString,
  objectRecord,
  operatorTokenLabel,
  specDisplayName,
  pageFromSpec,
  blocksFromSpec,
  formatJson,
  labelDesignTemplateSummary,
  describeDraftError,
} from './label-design-template';

interface LabelDesignerShipmentRow extends Record<string, unknown> {
  id: string;
  tracking_number?: string | null;
  shipment_display_id?: string | null;
  recipient_label?: string | null;
  destination_city?: string | null;
  status?: string | null;
  organization_id?: string | null;
}

interface LabelDesignerShipmentBoxRow extends Record<string, unknown> {
  id: string;
  shipment_id?: string | null;
  box_number?: number | string | null;
  barcode_value?: string | null;
  weight_kg?: number | null;
}

function labelDesignerShipmentLabel(row: LabelDesignerShipmentRow): string {
  return (
    nonEmptyString(row.tracking_number) ??
    nonEmptyString(row.shipment_display_id) ??
    row.id
  );
}

function labelDesignerShipmentSub(row: LabelDesignerShipmentRow): string {
  return [
    nonEmptyString(row.recipient_label),
    nonEmptyString(row.destination_city),
    nonEmptyString(row.status),
  ].filter(Boolean).join(' - ');
}

function labelDesignerShipmentBoxLabel(row: LabelDesignerShipmentBoxRow): string {
  const boxNumber = nonEmptyString(row.box_number);
  const barcode = nonEmptyString(row.barcode_value);
  if (boxNumber && barcode) return `Box ${boxNumber} - ${barcode}`;
  if (boxNumber) return `Box ${boxNumber}`;
  return barcode ?? row.id;
}

function defaultLabelTypeValue(options: LabelTypeOption[]): string {
  return options.find((option) => option.is_default)?.value ?? options[0]?.value ?? '';
}

function labelDesignValueFromSpec(spec: LabelSpec | undefined, labelType: string): Record<string, unknown> {
  const renderer = spec?.renderer_config ?? {};
  const normalizedLabelType = labelType.trim();
  const templateKey = spec ? specDisplayName(spec) : normalizedLabelType;
  const nextVersion = Number(spec?.version ?? 0) + 1;
  const assets = Array.isArray(renderer.assets)
    ? renderer.assets
    : Array.isArray(spec?.asset_refs)
      ? spec.asset_refs
      : [];
  const rendererBarcode = renderer.barcode && typeof renderer.barcode === 'object'
    ? renderer.barcode as Record<string, unknown>
    : {};
  return {
    templates: {
      [normalizedLabelType]: {
        template_key: templateKey,
        label_type: normalizedLabelType,
        version: `v${nextVersion}`,
        page: pageFromSpec(spec),
        blocks: blocksFromSpec(spec),
        assets,
        barcode: {
          type: spec?.barcode_format ?? rendererBarcode.type ?? 'CODE128',
          value_path: 'shipment.tracking_number',
        },
      },
    },
  };
}

function withLabelDesignTemplate(
  value: Record<string, unknown>,
  labelType: string,
  update: (template: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const templates = objectRecord(value.templates);
  const current = objectRecord(templates[labelType]);
  return {
    ...value,
    templates: {
      ...templates,
      [labelType]: update({
        template_key: current.template_key ?? labelType,
        label_type: current.label_type ?? labelType,
        page: objectRecord(current.page).width_inch || objectRecord(current.page).width_mm
          ? objectRecord(current.page)
          : { width_inch: 4, height_inch: 6, dpi: 203, margin_inch: 0.12 },
        blocks: Array.isArray(current.blocks) ? current.blocks : [],
        assets: Array.isArray(current.assets) ? current.assets : [],
        barcode: objectRecord(current.barcode).type
          ? objectRecord(current.barcode)
          : { type: 'CODE128', value_path: 'shipment.tracking_number' },
        ...current,
      }),
    },
  };
}

function assetNameFromPath(path: string): string {
  const leaf = path.split('/').filter(Boolean).pop() ?? path;
  return leaf.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'label_asset';
}

function addLabelDesignAsset(
  value: Record<string, unknown>,
  labelType: string,
  asset: { name?: string | null; path: string; content_type?: string | null },
): Record<string, unknown> {
  const assetPath = asset.path.trim();
  const assetName = (asset.name?.trim() || assetNameFromPath(assetPath)).slice(0, 80);
  return withLabelDesignTemplate(value, labelType, (template) => {
    const assets = Array.isArray(template.assets)
      ? [...template.assets.filter((item) => {
        const rec = objectRecord(item);
        return nonEmptyString(rec.path) !== assetPath && nonEmptyString(rec.name) !== assetName;
      })]
      : [];
    assets.push({
      name: assetName,
      path: assetPath,
      content_type: asset.content_type ?? 'image/png',
    });
    const blocks = Array.isArray(template.blocks) ? [...template.blocks] : [];
    blocks.push({
      type: 'image',
      section_key: `asset_${assets.length}`,
      asset_ref: assetName,
      value_path: assetName,
      x: 218,
      y: 84 + (assets.length - 1) * 50,
      width: 70,
      height: 42,
      align: 'left',
    });
    return { ...template, assets, blocks };
  });
}

function removeLabelDesignAsset(
  value: Record<string, unknown>,
  labelType: string,
  path: string,
): Record<string, unknown> {
  const assetPath = path.trim();
  return withLabelDesignTemplate(value, labelType, (template) => {
    const currentAssets = Array.isArray(template.assets) ? template.assets : [];
    const removedNames = new Set(
      currentAssets
        .map((item) => objectRecord(item))
        .filter((item) => nonEmptyString(item.path) === assetPath)
        .map((item) => nonEmptyString(item.name))
        .filter((name): name is string => Boolean(name)),
    );
    const assets = currentAssets.filter((item) => nonEmptyString(objectRecord(item).path) !== assetPath);
    const blocks = Array.isArray(template.blocks)
      ? template.blocks.filter((item) => !removedNames.has(nonEmptyString(objectRecord(item).asset_ref) ?? ''))
      : [];
    return { ...template, assets, blocks };
  });
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read selected file'));
    reader.readAsDataURL(file);
  });
}

export function LabelDesignComposer({
  baseSpec,
  initialDraft,
  scopeType,
  scopeId,
  scopeLabel,
  labelTypes,
  canWrite,
  onClose,
}: {
  baseSpec?: LabelSpec;
  initialDraft?: LabelDesignDraft;
  scopeType: LabelDesignScopeType;
  scopeId: string;
  scopeLabel: string;
  labelTypes: LabelTypeOption[];
  canWrite: boolean;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const t = createUiTranslator('ui.labelDesigner.studio', { locale });
  const createDraft = useCreateLabelDesignDraft();
  const updateDraft = useUpdateLabelDesignDraft();
  const validateDraft = useValidateLabelDesignDraft();
  const publishDraft = usePublishLabelDesignDraft();
  const fieldCatalogQuery = useLabelDesignerFieldCatalog(scopeType, scopeId);
  const effectiveConfigQuery = useLabelDesignerEffectiveConfig(scopeType, scopeId);
  const assetsQuery = useLabelDesignerAssets(scopeType, scopeId);
  const uploadAsset = useUploadLabelDesignerAsset();
  const deleteAsset = useDeleteLabelDesignerAsset();
  const samplePayload = useLabelDesignerSamplePayload();
  const previewDraft = usePreviewLabelDesignDraft();
  const shipmentQuery = useResourceList<LabelDesignerShipmentRow>('shipment_directory', {
    sort: { key: 'created_at', dir: 'desc' },
    page_size: 50,
  });
  const availableLabelTypes = labelTypes;
  const initialLabelType = defaultLabelTypeValue(availableLabelTypes);
  const initialDraftLabelType = initialDraft?.label_type ?? initialLabelType;
  const [draftName, setDraftName] = useState(
    initialDraft?.draft_name ?? `${baseSpec ? specDisplayName(baseSpec) : (initialDraftLabelType || 'label')} active design`,
  );
  const [labelType, setLabelType] = useState(initialDraftLabelType);
  const [currentDraft, setCurrentDraft] = useState<LabelDesignDraft | null>(initialDraft ?? null);
  const [lastSavedDraftId, setLastSavedDraftId] = useState<string | null>(initialDraft?.id ?? null);
  const [publishedReadback, setPublishedReadback] = useState<{
    settingsVersionId?: string | null;
    scopeType?: string | null;
    scopeId?: string | null;
    version?: number | null;
  } | null>(null);
  const [changeReason, setChangeReason] = useState(`Activate ${scopeType} label design from Console V2`);
  const [draftText, setDraftText] = useState(() => (
    initialDraft
      ? formatJson(initialDraft.draft_value)
      : initialDraftLabelType
        ? formatJson(labelDesignValueFromSpec(baseSpec, initialDraftLabelType))
        : '{}'
  ));
  const [error, setError] = useState<string | null>(null);
  const [pastedAssetName, setPastedAssetName] = useState(() => `label-designer-asset-${Date.now()}.png`);
  const [pastedAssetDataUrl, setPastedAssetDataUrl] = useState('');
  const [isAssetDropActive, setIsAssetDropActive] = useState(false);
  const [assetReadback, setAssetReadback] = useState<{
    action: 'uploaded' | 'deleted';
    path: string;
    source: string;
    contentType?: string | null;
  } | null>(null);
  const [selectedPreviewShipmentId, setSelectedPreviewShipmentId] = useState('');
  const [selectedPreviewShipmentBoxId, setSelectedPreviewShipmentBoxId] = useState('');
  const [samplePayloadText, setSamplePayloadText] = useState('');
  const [previewResponseText, setPreviewResponseText] = useState('');
  const boxQuery = useResourceList<LabelDesignerShipmentBoxRow>(
    'shipment_boxes',
    selectedPreviewShipmentId
      ? {
        filter: { shipment_id: selectedPreviewShipmentId },
        sort: { key: 'box_number', dir: 'asc' },
        page_size: 50,
      }
      : undefined,
    { enabled: Boolean(selectedPreviewShipmentId) },
  );
  const isBusy = createDraft.isPending || updateDraft.isPending || validateDraft.isPending || publishDraft.isPending || uploadAsset.isPending || deleteAsset.isPending || samplePayload.isPending || previewDraft.isPending;
  const hasLabelTypes = availableLabelTypes.length > 0;
  const canMutateDesign = canWrite && hasLabelTypes;
  const writeDeniedMessage = t('writeDenied');
  const availableAssets = assetsQuery.data?.assets ?? [];
  const assetReadbackConfirmed = assetReadback
    ? assetReadback.action === 'deleted'
      ? !availableAssets.some((asset) => asset.path === assetReadback.path)
      : availableAssets.some((asset) => asset.path === assetReadback.path)
    : false;
  const visualSummary = useMemo(() => {
    try {
      return labelDesignTemplateSummary(parseJsonObject(draftText, 'Label design'), labelType);
    } catch {
      return null;
    }
  }, [draftText, labelType]);
  useEffect(() => {
    if (selectedPreviewShipmentId) return;
    const firstShipmentId = nonEmptyString(shipmentQuery.data?.rows?.[0]?.id);
    if (firstShipmentId) setSelectedPreviewShipmentId(firstShipmentId);
  }, [selectedPreviewShipmentId, shipmentQuery.data?.rows]);

  useEffect(() => {
    const boxes = boxQuery.data?.rows ?? [];
    if (selectedPreviewShipmentBoxId && boxes.some((box) => box.id === selectedPreviewShipmentBoxId)) return;
    setSelectedPreviewShipmentBoxId(nonEmptyString(boxes[0]?.id) ?? '');
  }, [boxQuery.data?.rows, selectedPreviewShipmentBoxId]);

  const updateDraftDesign = (update: (value: Record<string, unknown>) => Record<string, unknown>) => {
    if (!canWrite) return;
    try {
      const next = update(parseJsonObject(draftText, 'Label design'));
      setDraftText(formatJson(next));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const changeLabelType = (nextLabelType: string) => {
    if (!canWrite) return;
    setLabelType(nextLabelType);
    if (!baseSpec && nextLabelType) {
      setDraftText(formatJson(labelDesignValueFromSpec(undefined, nextLabelType)));
      setDraftName((current) => (
        current.trim() === '' || current === `${labelType || 'label'} active design`
          ? `${nextLabelType} active design`
          : current
      ));
    }
  };

  const uploadAssetPayload = async ({
    fileName,
    contentType,
    fileBase64,
  }: {
    fileName: string;
    contentType: string;
    fileBase64: string;
  }): Promise<boolean> => {
    setError(null);
    if (!canWrite) {
      setError(writeDeniedMessage);
      return false;
    }
    try {
      const uploaded = await uploadAsset.mutateAsync({
        scopeType,
        scopeId,
        file_name: fileName,
        content_type: contentType || 'image/png',
        file_base64: fileBase64,
      });
      const path = nonEmptyString(uploaded.path);
      if (!path) throw new Error('Asset upload returned no storage path');
      updateDraftDesign((value) => addLabelDesignAsset(value, labelType, {
        name: assetNameFromPath(path),
        path,
        content_type: contentType || 'image/png',
      }));
      setAssetReadback({
        action: 'uploaded',
        path,
        source: fileName,
        contentType: contentType || 'image/png',
      });
      pushToast(t('assetUploaded', { path }), 'good');
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const uploadAssetFile = async (file: File | null | undefined) => {
    if (!canWrite) {
      setError(writeDeniedMessage);
      return;
    }
    if (!file) return;
    setError(null);
    try {
      const fileBase64 = await readFileAsDataUrl(file);
      await uploadAssetPayload({
        fileName: file.name,
        contentType: file.type || 'image/png',
        fileBase64,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const uploadDroppedAsset = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsAssetDropActive(false);
    if (!canWrite || isBusy || !labelType) return;
    void uploadAssetFile(event.dataTransfer.files?.[0] ?? null);
  };

  const uploadPastedAsset = async () => {
    if (!canWrite) {
      setError(writeDeniedMessage);
      return;
    }
    const fileName = pastedAssetName.trim();
    const fileBase64 = pastedAssetDataUrl.trim();
    if (!fileName) {
      setError(t('fileNameRequired'));
      return;
    }
    if (!fileBase64) {
      setError(t('imageDataRequired'));
      return;
    }
    const contentType = fileBase64.match(/^data:([^;,]+)[;,]/i)?.[1] ?? 'image/png';
    const uploaded = await uploadAssetPayload({ fileName, contentType, fileBase64 });
    if (uploaded) {
      setPastedAssetName('');
      setPastedAssetDataUrl('');
    }
  };

  const selectAsset = (asset: { name?: string | null; path?: string | null; content_type?: string | null }) => {
    if (!canWrite) return;
    const path = nonEmptyString(asset.path);
    if (!path) return;
    updateDraftDesign((value) => addLabelDesignAsset(value, labelType, {
      name: nonEmptyString(asset.name) ?? assetNameFromPath(path),
      path,
      content_type: nonEmptyString(asset.content_type) ?? 'image/png',
    }));
  };

  const deleteAssetPath = async (path: string) => {
    if (!canWrite) {
      setError(writeDeniedMessage);
      return;
    }
    try {
      await deleteAsset.mutateAsync({ path, scopeType, scopeId });
      updateDraftDesign((value) => removeLabelDesignAsset(value, labelType, path));
      setAssetReadback({
        action: 'deleted',
        path,
        source: assetNameFromPath(path),
      });
      pushToast(t('assetDeleted', { path }), 'good');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveDraft = async (): Promise<LabelDesignDraft | null> => {
    setError(null);
    if (!canWrite) {
      setError(writeDeniedMessage);
      return null;
    }
    if (!labelType) {
      setError(t('saveTypesMissing'));
      return null;
    }
    let draftValue: Record<string, unknown>;
    try {
      draftValue = parseJsonObject(draftText, 'Label design');
    } catch (err) {
      setError((err as Error).message);
      return null;
    }

    const result = currentDraft?.status === 'draft'
      ? await updateDraft.mutateAsync({
        draft_id: currentDraft.id,
        label_type: labelType,
        draft_name: draftName.trim() || null,
        draft_value: draftValue,
        scopeType,
        scopeId,
      })
      : await createDraft.mutateAsync({
        scope_type: scopeType,
        scope_id: scopeId,
        label_type: labelType,
        draft_name: draftName.trim() || null,
        draft_value: draftValue,
      });

    if (!result.ok || !result.draft?.id) {
      setError(describeDraftError(result.error));
      return null;
    }

    setCurrentDraft(result.draft);
    setLastSavedDraftId(result.draft.id);
    setPublishedReadback(null);
    pushToast(t('draftSaved', { id: result.draft.id }), 'good');
    return result.draft;
  };

  const submit = async () => {
    setError(null);
    const savedDraft = await saveDraft();
    if (!savedDraft?.id) return;

    const validation = await validateDraft.mutateAsync(savedDraft.id);
    if (!validation.ok) {
      const detail = validation.errors.length
        ? validation.errors.map((item) => item.message ?? item.code).join('; ')
        : describeDraftError(validation.error);
      setError(t('validationFailed', { detail }));
      return;
    }

    const published = await publishDraft.mutateAsync({
      draftId: savedDraft.id,
      changeReason,
      scopeType,
      scopeId,
    });
    if (!published.ok) {
      const detail = published.validation_errors?.length
        ? published.validation_errors.map((item) => item.message ?? item.code).join('; ')
        : describeDraftError(published.error);
      setError(t('publishFailed', { detail }));
      return;
    }

    setCurrentDraft({
      ...savedDraft,
      status: 'published',
      published_settings_version_id: published.settings_version_id ?? savedDraft.published_settings_version_id ?? null,
      published_at: new Date().toISOString(),
    });
    setPublishedReadback({
      settingsVersionId: published.settings_version_id ?? null,
      scopeType: published.scope_type ?? scopeType,
      scopeId: published.scope_id ?? scopeId,
      version: typeof published.version === 'number' ? published.version : null,
    });
    pushToast(
      t('activated', { version: published.settings_version_id ?? '-' }),
      'good',
    );
  };

  const loadPreviewSamplePayload = async () => {
    setError(null);
    if (!selectedPreviewShipmentId) {
      setError(t('selectSampleShipment'));
      return;
    }
    try {
      const result = await samplePayload.mutateAsync({
        shipment_id: selectedPreviewShipmentId,
        shipment_box_id: selectedPreviewShipmentBoxId || null,
      });
      if (!result.ok || !result.payload) {
        setError(t('sampleFailed', { detail: describeDraftError(result.error) }));
        return;
      }
      setSamplePayloadText(formatJson(result.payload));
      pushToast(t('sampleLoaded', { id: selectedPreviewShipmentId }), 'good');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const renderPreview = async () => {
    setError(null);
    if (!selectedPreviewShipmentId) {
      setError(t('selectPreviewShipment'));
      return;
    }
    const savedDraft = await saveDraft();
    if (!savedDraft?.id) return;
    try {
      const result = await previewDraft.mutateAsync({
        draft_id: savedDraft.id,
        label_type: labelType,
        shipment_id: selectedPreviewShipmentId,
        shipment_box_id: selectedPreviewShipmentBoxId || null,
      });
      setPreviewResponseText(formatJson(result));
      if (!result.ok) {
        setError(t('previewFailed', { detail: describeDraftError(result.error) }));
        return;
      }
      pushToast(t('previewRendered', { id: savedDraft.id }), 'good');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const designerBusyAction = createDraft.isPending
    ? 'create-draft'
    : updateDraft.isPending
      ? 'save-draft'
      : validateDraft.isPending
        ? 'validate-draft'
        : publishDraft.isPending
          ? 'publish-draft'
          : null;
  const fieldCatalogJson = useMemo(() => formatJson(fieldCatalogQuery.data?.value ?? { fields: [] }), [fieldCatalogQuery.data?.value]);
  const fieldCatalogCount = Array.isArray(fieldCatalogQuery.data?.value?.fields)
    ? fieldCatalogQuery.data.value.fields.length
    : 0;
  const previewShipmentOptions = useMemo<ShipmentOption[]>(() => (
    (shipmentQuery.data?.rows ?? []).map((shipment) => ({
      id: shipment.id,
      label: [
        labelDesignerShipmentLabel(shipment),
        labelDesignerShipmentSub(shipment),
      ].filter(Boolean).join(' - '),
    }))
  ), [shipmentQuery.data?.rows]);
  const previewShipmentBoxOptions = useMemo<ShipmentBoxOption[]>(() => (
    (boxQuery.data?.rows ?? []).map((box) => ({
      id: box.id,
      label: labelDesignerShipmentBoxLabel(box),
    }))
  ), [boxQuery.data?.rows]);
  const previewBusyAction = samplePayload.isPending
    ? 'sample-payload'
    : previewDraft.isPending
      ? 'preview-draft'
      : null;
  const sharedDesignerDrafts = useMemo<DraftRow[]>(() => (currentDraft ? [currentDraft as DraftRow] : []), [currentDraft]);
  const sharedSelectedScope = useMemo(() => (
    scopeId ? { scopeType, scopeId } : null
  ), [scopeId, scopeType]);

  const changeDraftEditor = (value: string) => {
    setDraftText(value);
    try {
      parseJsonObject(value, 'Label design');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const selectSharedDraft = (draftId: string) => {
    const draft = sharedDesignerDrafts.find((item) => item.id === draftId) as LabelDesignDraft | undefined;
    if (!draft) {
      setCurrentDraft(null);
      setLastSavedDraftId(null);
      return;
    }
    setCurrentDraft(draft);
    setLastSavedDraftId(draft.id);
    setDraftName(draft.draft_name ?? draft.label_type);
    setLabelType(draft.label_type);
    setDraftText(formatJson(draft.draft_value));
    setError(null);
  };

  const createSharedDraft = async () => {
    const saved = await saveDraft();
    if (saved?.id) {
      setCurrentDraft(saved);
      setLastSavedDraftId(saved.id);
    }
  };

  const validateSharedDraft = async () => {
    setError(null);
    const savedDraft = currentDraft?.id ? currentDraft : await saveDraft();
    if (!savedDraft?.id) return;
    const validation = await validateDraft.mutateAsync(savedDraft.id);
    if (!validation.ok) {
      const detail = validation.errors.length
        ? validation.errors.map((item) => item.message ?? item.code).join('; ')
        : describeDraftError(validation.error);
      setError(t('validationFailed', { detail }));
      return;
    }
    pushToast(t('draftValidated', { id: savedDraft.id }), 'good');
  };

  return (
    <div data-testid="label-design-composer">
      <p className="state__hint">
        {t('publishDetail', { scope: scopeLabel })}
      </p>
      {lastSavedDraftId ? (
        <div className="dt-toolbar" data-testid="label-design-save-readback" style={{ marginBottom: '8px' }}>
          <span className="eyebrow">{t('draftConfirmation')}</span>
          <Chip label={t('draftId', { id: lastSavedDraftId })} size="xs" kind="good" />
          <Chip label={t('draftStatus', { status: currentDraft?.status ?? 'draft' })} size="xs" />
          {publishedReadback ? (
            <>
              <Chip label={t('settingsVersion', { version: publishedReadback.settingsVersionId ?? '-' })} size="xs" kind="good" />
              <Chip
                label={t('scope', { type: operatorTokenLabel(publishedReadback.scopeType ?? scopeType), id: publishedReadback.scopeId ?? scopeId })}
                size="xs"
              />
              {publishedReadback.version ? (
                <Chip label={t('version', { version: publishedReadback.version })} size="xs" />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {!hasLabelTypes ? (
        <StateView
          kind="error"
          title={t('typesMissing')}
          hint={t('publishTypesMissing')}
        />
      ) : null}
      <div className="field">
        <label className="field__label">{t('changeReason')}</label>
        <input
          aria-label={t('changeReason')}
          type="text"
          value={changeReason}
          disabled={!canWrite || isBusy}
          onChange={(event) => {
            if (!canWrite || isBusy) return;
            setChangeReason(event.target.value);
          }}
        />
      </div>
      <div className="card label-designer-studio" data-testid="label-design-visual-editor" style={{ padding: '10px', marginBottom: '10px' }}>
        <div className="dt-toolbar" style={{ marginBottom: '8px' }}>
          <span className="eyebrow">{t('visualDesigner')}</span>
          {visualSummary ? (
            <>
              <Chip label={t('template', { key: visualSummary.templateKey })} size="xs" />
              <Chip label={t('blocks', { count: visualSummary.blocks.length })} size="xs" />
              <Chip label={t('assets', { count: visualSummary.assetsCount })} size="xs" />
            </>
          ) : null}
        </div>
        {!fieldCatalogQuery.isLoading && fieldCatalogCount === 0 ? (
          <StateView
            kind="error"
            title={t('missingFields')}
            hint={t('fieldSetup')}
          />
        ) : null}
        <DraftWorkflow
          prefix="label-design-shared"
          canWrite={canMutateDesign}
          isBusy={isBusy}
          busyAction={designerBusyAction}
          selectedScope={sharedSelectedScope}
          drafts={sharedDesignerDrafts}
          selectedDraftId={currentDraft?.id ?? ''}
          draftName={draftName}
          labelType={labelType}
          labelTypeOptions={availableLabelTypes.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          draftEditor={draftText}
          draftEditorError={error}
          fieldCatalogJson={fieldCatalogJson}
          assets={availableAssets}
          onDraftSelection={selectSharedDraft}
          onDraftNameChange={setDraftName}
          onLabelTypeChange={changeLabelType}
          onDraftEditorChange={changeDraftEditor}
          onCreateDraft={() => { void createSharedDraft(); }}
          onSaveDraft={() => { void saveDraft(); }}
          onValidateDraft={() => { void validateSharedDraft(); }}
          onPublishDraft={() => { void submit(); }}
        />
        <div data-testid="label-designer-asset-workbench" style={{ marginTop: '10px' }}>
          <div
            role="button"
            tabIndex={0}
            aria-label={t('dropLabelAsset')}
            data-testid="label-designer-asset-dropzone"
            onDragEnter={(event) => {
              event.preventDefault();
              if (canWrite && !isBusy && labelType) setIsAssetDropActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (canWrite && !isBusy && labelType) event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setIsAssetDropActive(false);
            }}
            onDrop={uploadDroppedAsset}
            style={{
              border: `1px dashed ${isAssetDropActive ? 'var(--accent)' : 'var(--line-strong)'}`,
              background: isAssetDropActive ? 'rgba(20, 120, 90, 0.08)' : 'var(--paper)',
              borderRadius: 8,
              padding: '10px',
              marginBottom: '8px',
            }}
          >
            <div className="dt-toolbar" style={{ marginBottom: 0 }}>
              <span className="eyebrow">{t('dropImageAsset')}</span>
              <Chip label={!canWrite ? t('readOnly') : isBusy ? t('uploading') : t('acceptedImages')} size="xs" />
            </div>
          </div>
          <div className="form-grid form-grid--2">
            <div className="field">
              <label className="field__label">{t('imageUpload')}</label>
              <input
                aria-label={t('uploadLabelAsset')}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={!canWrite || isBusy || !labelType}
                onChange={(event) => {
                  void uploadAssetFile(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('assetCatalog')}</label>
              <div className="state__hint mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
                {assetsQuery.isLoading
                  ? t('loadingAssets')
                  : t('assetsAvailable', { count: availableAssets.length })}
              </div>
            </div>
          </div>
          <div className="form-grid form-grid--2" style={{ marginTop: '8px' }}>
            <div className="field">
              <label className="field__label">{t('pastedFileName')}</label>
              <input
                aria-label={t('pastedFileName')}
                type="text"
                value={pastedAssetName}
                onChange={(event) => setPastedAssetName(event.target.value)}
                disabled={!canWrite || isBusy || !labelType}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('pastedDataUrl')}</label>
              <textarea
                aria-label={t('pastedDataUrl')}
                rows={3}
                value={pastedAssetDataUrl}
                onChange={(event) => setPastedAssetDataUrl(event.target.value)}
                disabled={!canWrite || isBusy || !labelType}
              />
            </div>
          </div>
          <div className="dt-toolbar" style={{ marginTop: '6px' }}>
            <Button
              label={t('importAsset')}
              iconName="upload"
              kind="ghost"
              disabled={!canWrite || isBusy || !labelType || !pastedAssetDataUrl.trim()}
              onClick={() => { void uploadPastedAsset(); }}
            />
          </div>
          {availableAssets.length > 0 ? (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
              {availableAssets.slice(0, 8).map((asset) => {
                const assetLabel = asset.name || assetNameFromPath(asset.path);
                return (
                  <span
                    key={asset.path}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0 }}
                  >
                    <Button
                      label={assetLabel}
                      iconName="file"
                      kind="ghost"
                      disabled={!canWrite}
                      onClick={() => selectAsset(asset)}
                    />
                    <Button
                      label={t('delete')}
                      iconName="trash"
                      kind="ghost"
                      ariaLabel={t('deleteAsset', { name: assetLabel })}
                      title={t('deleteAsset', { name: assetLabel })}
                      disabled={!canWrite || deleteAsset.isPending}
                      onClick={() => { void deleteAssetPath(asset.path); }}
                    />
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="state__hint" style={{ marginTop: '6px' }}>
              {t('addImageInstruction')}
            </div>
          )}
          {assetReadback ? (
            <div
              className="card"
              data-testid="label-designer-asset-readback"
              data-readback-action={assetReadback.action}
              data-readback-status={assetReadbackConfirmed ? 'confirmed' : 'pending'}
              data-asset-path={assetReadback.path}
              style={{ padding: '10px', marginTop: '8px' }}
            >
              <div className="dt-toolbar">
                <span className="eyebrow">{t('assetConfirmation')}</span>
                <Chip
                  label={assetReadback.action === 'deleted' ? t('storageRemoved') : t('storageUploaded')}
                  size="xs"
                  kind={assetReadbackConfirmed ? 'good' : 'warn'}
                />
                <Chip
                  label={t('assetCatalogStatus', { confirmed: assetReadbackConfirmed ? 'yes' : 'no' })}
                  size="xs"
                  kind={assetReadbackConfirmed ? 'good' : undefined}
                />
                {assetReadback.contentType ? (
                  <Chip label={assetReadback.contentType} size="xs" />
                ) : null}
              </div>
              <div className="mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
                {assetReadback.path}
              </div>
              <p className="state__hint" style={{ marginTop: 6 }}>
                {assetReadback.action === 'deleted'
                  ? t('catalogRemoved')
                  : t('assetCatalogIncludes', { source: assetReadback.source })}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      <div data-testid="label-design-preview-workbench" style={{ marginBottom: '10px' }}>
        <PreviewPanel
          prefix="label-design-shared-preview"
          isBusy={isBusy}
          busyAction={previewBusyAction}
          shipments={previewShipmentOptions}
          selectedShipmentId={selectedPreviewShipmentId}
          shipmentBoxes={previewShipmentBoxOptions}
          selectedShipmentBoxId={selectedPreviewShipmentBoxId}
          selectedDraftId={canWrite ? currentDraft?.id ?? (draftText.trim() ? 'unsaved-draft' : '') : ''}
          samplePayloadJson={samplePayloadText || '{}'}
          previewResponseJson={previewResponseText}
          onShipmentChange={(id) => {
            setSelectedPreviewShipmentId(id);
            setSelectedPreviewShipmentBoxId('');
            setSamplePayloadText('');
            setPreviewResponseText('');
          }}
          onShipmentBoxChange={setSelectedPreviewShipmentBoxId}
          onLoadSamplePayload={() => { void loadPreviewSamplePayload(); }}
          onPreviewDraft={() => { void renderPreview(); }}
        />
        <div className="card" data-testid="label-design-effective-config-readback" style={{ padding: '10px', marginTop: '10px' }}>
          <div className="dt-toolbar">
            <span className="eyebrow">{t('effectiveConfiguration')}</span>
            <Chip label={currentDraft?.id ? t('draftId', { id: currentDraft.id }) : t('saveBeforePreview')} size="xs" kind={currentDraft?.id ? 'good' : 'warn'} />
            <Chip label={selectedPreviewShipmentId ? t('shipmentId', { id: selectedPreviewShipmentId }) : t('shipmentRequired')} size="xs" kind={selectedPreviewShipmentId ? 'good' : 'warn'} />
          </div>
          <div className="form-grid form-grid--2" style={{ marginTop: '8px' }}>
            <div className="field">
              <label className="field__label">{t('effectiveDesign')}</label>
              <textarea
                aria-label={t('effectiveDesign')}
                className="mono"
                rows={8}
                readOnly
                value={formatJson(effectiveConfigQuery.data?.design?.value ?? {})}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('effectiveRenderPolicy')}</label>
              <textarea
                aria-label={t('effectiveRenderPolicy')}
                className="mono"
                rows={8}
                readOnly
                value={formatJson(effectiveConfigQuery.data?.renderPolicy?.value ?? {})}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('effectivePrintProfile')}</label>
              <textarea
                aria-label={t('effectivePrintProfile')}
                className="mono"
                rows={8}
                readOnly
                value={formatJson(effectiveConfigQuery.data?.printProfile?.value ?? {})}
              />
            </div>
            <div className="field">
              <label className="field__label">{t('effectiveMediaCatalog')}</label>
              <textarea
                aria-label={t('effectiveMediaCatalog')}
                className="mono"
                rows={8}
                readOnly
                value={formatJson(effectiveConfigQuery.data?.mediaCatalog?.value ?? {})}
              />
            </div>
          </div>
        </div>
      </div>
      {error ? (
        <StateView kind="error" title={t('actionFailed')} hint={error} />
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
        <Button label={t('cancel')} kind="ghost" onClick={onClose} />
      </div>
    </div>
  );
}
