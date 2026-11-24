import {
  _numberFromUnknown,
  backendOutcomeError,
  DELIVERY_SLOT_CATALOG,
  type DeliverySlotWindow,
  getLiveShipmentClientId,
  LIVE_MUTATION_EVIDENCE_KEYS,
  liveBackendUnavailableError,
  liveRpc,
  lookupCommandContractRow,
  normalizeDeliverySlotWindow,
  objectRecord,
  requireLiveEvidence,
  requireLiveMutationResult,
  requireLiveNumberField,
  requireLiveResourceReadback,
  requireLiveRpcRecord,
  requireLiveStringField,
  SA_SHORT_ADDRESS_READBACK_KEYS,
  seed,
  type ShipmentResortResult,
  type ShipmentUpdateGeocodeResult,
  sleep,
  type UiCreateShipmentArgs,
  type UiCreateShipmentResult,
} from '../data-source';
import { coordinatePairFromUnknown } from '../geo-coordinates';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { asNonEmptyString } from './shared';

function normalizeUiCreateShipmentResult(
  rec: Record<string, unknown>,
  dryRun: boolean,
): UiCreateShipmentResult {
  return {
    ...rec,
    status: String(rec.status ?? (dryRun ? 'shipment_create_preview' : 'workflow_started')),
    workflow_template_id: rec.workflow_template_id == null ? null : String(rec.workflow_template_id),
    workflow_run_id: rec.workflow_run_id == null ? null : String(rec.workflow_run_id),
    workflow_status: rec.workflow_status == null ? null : String(rec.workflow_status),
    correlation_id: rec.correlation_id == null ? null : String(rec.correlation_id),
    shipment_id: rec.shipment_id == null ? null : String(rec.shipment_id),
    tracking_number: rec.tracking_number == null ? null : String(rec.tracking_number),
    operation: rec.operation == null ? null : String(rec.operation),
    recipient_id: rec.recipient_id == null ? null : String(rec.recipient_id),
    label_job_id: rec.label_job_id == null ? null : String(rec.label_job_id),
    address_workflow_run_id: rec.address_workflow_run_id == null ? null : String(rec.address_workflow_run_id),
    dry_run: Boolean(rec.dry_run ?? dryRun),
  };
}

function promoteManualShipmentIntakeEvidence(
  rec: Record<string, unknown>,
  dryRun: boolean,
): Record<string, unknown> {
  const nested = objectRecord(dryRun ? rec.shipment_preview : rec.shipment_result);
  const addressResult = objectRecord(rec.address_result);
  const promoted: Record<string, unknown> = { ...rec };
  const promoteString = (targetKey: string, values: unknown[]): void => {
    if (asNonEmptyString(promoted[targetKey])) return;
    const value = values.map(asNonEmptyString).find(Boolean);
    if (value) promoted[targetKey] = value;
  };

  promoteString('workflow_template_id', [
    nested.workflow_template_id,
    nested.workflow_template,
    nested.template_id,
  ]);
  promoteString('workflow_run_id', [nested.workflow_run_id, nested.run_id]);
  promoteString('workflow_status', [nested.workflow_status]);
  promoteString('correlation_id', [nested.correlation_id]);
  promoteString('shipment_id', [nested.shipment_id]);
  promoteString('tracking_number', [nested.tracking_number]);
  promoteString('operation', [nested.operation]);
  promoteString('recipient_id', [nested.recipient_id]);
  promoteString('label_job_id', [nested.label_job_id]);
  promoteString('address_workflow_run_id', [addressResult.workflow_run_id, nested.address_workflow_run_id]);

  return promoted;
}

function isManualShipmentIntakeReuseResult(rec: Record<string, unknown>): boolean {
  const status = String(rec.status ?? '').toLowerCase();
  const operation = String(rec.operation ?? '').toLowerCase();
  return (
    rec.duplicate_reused === true ||
    status === 'manual_shipment_intake_reused' ||
    operation === 'reused' ||
    operation.startsWith('reused_')
  );
}

function seedCreateManualShipmentResult(
  args: UiCreateShipmentArgs,
  dryRun: boolean,
): UiCreateShipmentResult {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const tracking = args.tracking_number ?? `SHP-${Math.floor(1000000 + Math.random() * 8999999)}`;
  const shipmentId = `shp_${nowMs}`;
  const recipientId = args.recipient_id ?? (args.new_recipient ? `rcp_${nowMs}` : null);
  const addressId = args.destination_address ? `addr_${nowMs}` : null;
  const labelId = `lbl_${shipmentId}_1`;
  const labelJobId = `lj_${nowMs}`;
  const labelSpec = ((seed.label_template_specs ?? []) as Array<Record<string, unknown>>)
    .find((spec) => String(spec.status ?? 'active') === 'active')
    ?? ((seed.label_template_specs ?? []) as Array<Record<string, unknown>>)[0]
    ?? {};
  const rendererConfig = (labelSpec.renderer_config ?? {}) as Record<string, unknown>;
  const serviceLookups = ((seed.lookups?.service_type ?? []) as Array<Record<string, unknown>>)
    .map((row) => String(row.value ?? '').trim())
    .filter(Boolean);
  const serviceOffering = ((seed.service_offerings ?? []) as Array<Record<string, unknown>>)
    .find((offering) => offering.id === args.service_offering_id);
  const serviceLevel = ((seed.service_levels ?? []) as Array<Record<string, unknown>>)
    .find((level) => level.id === serviceOffering?.service_level_id);
  const serviceLevelKey = String(serviceLevel?.key ?? '').trim();
  const requestedServiceType = String(args.service_type ?? '').trim();
  const serviceType =
    (serviceLookups.includes(serviceLevelKey) && serviceLevelKey)
    || (serviceLookups.includes(requestedServiceType) && requestedServiceType)
    || serviceLookups[0]
    || requestedServiceType
    || null;

  if (!dryRun) {
    const newRecipient = (args.new_recipient ?? null) as Record<string, unknown> | null;
    const destinationAddress = (args.destination_address ?? null) as Record<string, unknown> | null;
    if (newRecipient && recipientId) {
      const recipients = (seed.recipients ?? []) as Array<Record<string, unknown>>;
      if (!recipients.some((recipient) => recipient.id === recipientId)) {
        recipients.unshift({
          id: recipientId,
          organization_id: args.organization_id ?? null,
          client_id: args.client_id ?? null,
          status: 'active',
          created_at: nowIso,
          updated_at: nowIso,
          ...newRecipient,
        });
      }
    }
    if (destinationAddress && addressId) {
      const addresses = (seed.addresses ?? []) as Array<Record<string, unknown>>;
      addresses.unshift({
        id: addressId,
        organization_id: args.organization_id ?? null,
        client_id: args.client_id ?? null,
        recipient_id: recipientId,
        normalized_line1: destinationAddress.line1 ?? null,
        street: destinationAddress.line1 ?? null,
        district: destinationAddress.district ?? null,
        city: destinationAddress.city ?? null,
        country: destinationAddress.country ?? null,
        postal_code: destinationAddress.postal_code ?? null,
        validation_status: 'pending',
        created_at: nowIso,
        updated_at: nowIso,
        ...destinationAddress,
      });
    }
    const shipments = (seed.shipments ?? []) as Array<Record<string, unknown>>;
    shipments.unshift({
      id: shipmentId,
      tracking_number: tracking,
      client_reference_number: args.client_reference_number ?? null,
      carrier_reference_number: args.carrier_reference_number ?? null,
      client_id: args.client_id ?? null,
      sender_id: args.sender_id ?? null,
      organization_id: args.organization_id ?? null,
      recipient_id: recipientId,
      destination_address_id: addressId,
      service_type: serviceType,
      status: args.status ?? 'pending',
      cod_amount: args.cod_amount ?? 0,
      cod_currency: args.cod_currency ?? null,
      promised_delivery_date: args.promised_delivery_date ?? null,
      box_count: 1,
      created_at: nowIso,
      updated_at: nowIso,
      destination_city: (args.destination_address as Record<string, unknown> | null | undefined)?.city ?? null,
      metadata: {
        ...(args.metadata ?? {}),
        requested_service_type: args.service_type ?? null,
        service_offering_id: args.service_offering_id ?? null,
        service_offering_label: serviceOffering?.display_name ?? serviceOffering?.name ?? null,
        service_level_id: serviceLevel?.id ?? null,
        service_level_key: serviceLevelKey || null,
        manual_intake_source: 'console_v2.shipment_create',
      },
    });
    ((seed.shipment_boxes ?? []) as Array<Record<string, unknown>>).push({
      id: `sbx_${shipmentId}_1`,
      shipment_id: shipmentId,
      box_number: 1,
      barcode: `${tracking}:1`,
    });
    ((seed.labels ?? []) as Array<Record<string, unknown>>).push({
      id: labelId,
      shipment_id: shipmentId,
      barcode: `${tracking}:1`,
      active_version_id: rendererConfig.active_version_id ?? null,
      print_count: 0,
      last_printed_at: null,
    });
    ((seed.label_jobs ?? []) as Array<Record<string, unknown>>).push({
      id: labelJobId,
      label_id: labelId,
      target_id: shipmentId,
      target_box_id: `sbx_${shipmentId}_1`,
      target_metadata: { box_index: 1 },
      spec_id: labelSpec.id ?? null,
      status: 'queued',
      queued_at: nowIso,
      completed_at: null,
      file_url: null,
    });
  }

  return {
    status: dryRun ? 'shipment_create_preview' : 'shipment_created',
    workflow_template_id: 'tpl_create_shipment',
    workflow_run_id: dryRun ? null : `wfr_${nowMs}`,
    workflow_status: dryRun ? 'preview' : 'completed',
    correlation_id: `cor_${Math.random().toString(36).slice(2, 10)}`,
    shipment_id: dryRun ? null : shipmentId,
    tracking_number: tracking,
    operation: dryRun ? 'preview' : 'inserted',
    recipient_id: dryRun ? null : recipientId,
    label_job_id: dryRun ? null : labelJobId,
    address_workflow_run_id: dryRun || !args.destination_address ? null : `wfr_address_${nowMs}`,
    dry_run: dryRun,
  };
}

export async function ui_create_shipment_v1(
  args: UiCreateShipmentArgs,
): Promise<UiCreateShipmentResult> {
  const dryRun = Boolean(args.dry_run);
  const hasManualIntakeEnvelope = Boolean(args.new_recipient || args.destination_address);
  const metadata: Record<string, unknown> = {
    ...(args.metadata ?? {}),
  };
  if (args.service_offering_id) metadata.service_offering_id = args.service_offering_id;
  if (args.organization_id) metadata.organization_id = args.organization_id;
  if (args.recipient_id) metadata.recipient_id = args.recipient_id;
  if (args.cod_amount != null) metadata.cod_amount = args.cod_amount;
  if (args.cod_currency) metadata.cod_currency = args.cod_currency;
  if (args.promised_delivery_date) metadata.promised_delivery_date = args.promised_delivery_date;
  if (args.promised_window_start_at) metadata.promised_window_start_at = args.promised_window_start_at;
  if (args.promised_window_end_at) metadata.promised_window_end_at = args.promised_window_end_at;
  if (args.priority_score != null) metadata.priority_score = args.priority_score;

  if (hasManualIntakeEnvelope) {
    const liveManual = await liveRpc<Record<string, unknown>>('ui_create_manual_shipment_intake_v1', {
      p_args: {
        organization_id: args.organization_id ?? null,
        client_id: args.client_id ?? null,
        sender_id: args.sender_id ?? null,
        recipient_id: args.recipient_id ?? null,
        new_recipient: args.new_recipient ?? null,
        destination_address: args.destination_address ?? null,
        service_type: args.service_type ?? null,
        service_offering_id: args.service_offering_id ?? null,
        tracking_number: args.tracking_number ?? null,
        client_reference_number: args.client_reference_number ?? null,
        carrier_reference_number: args.carrier_reference_number ?? null,
        status: args.status ?? 'pending',
        cod_amount: args.cod_amount ?? null,
        cod_currency: args.cod_currency ?? null,
        metadata,
        request_label: true,
        dry_run: dryRun,
      },
    });
    if (liveManual) {
      const rec = requireLiveManualShipmentIntakeResult(liveManual.data, dryRun);
      const reusedManualIntake = isManualShipmentIntakeReuseResult(rec);
      if (!dryRun) {
        requireLiveStringField(
          rec,
          ['shipment_id'],
          'ui_create_manual_shipment_intake_v1 did not return shipment_id',
        );
        if (!reusedManualIntake) {
          requireLiveStringField(
            rec,
            ['workflow_run_id'],
            'ui_create_manual_shipment_intake_v1 did not return workflow_run_id',
          );
        }
        requireLiveStringField(
          rec,
          ['tracking_number'],
          'ui_create_manual_shipment_intake_v1 did not return tracking_number',
        );
      }
      const result = normalizeUiCreateShipmentResult(rec, dryRun);
      if (!dryRun) {
        await requireLiveShipmentCreateReadback('ui_create_manual_shipment_intake_v1', args, result, rec);
      }
      return result;
    }
  }

  const live = await liveRpc<Record<string, unknown>>('ui_create_shipment_v1', {
    p_client_id: args.client_id ?? null,
    p_sender_id: args.sender_id ?? null,
    p_service_type: args.service_type ?? null,
    p_tracking_number: args.tracking_number ?? null,
    p_client_reference_number: args.client_reference_number ?? null,
    p_carrier_reference_number: args.carrier_reference_number ?? null,
    p_status: args.status ?? 'pending',
    p_metadata: dryRun
      ? { ...metadata, ui: { dry_run: true } }
      : metadata,
  });
  if (live) {
    const rec = requireLiveMutationResult(
      live.data,
      'ui_create_shipment_v1',
      dryRun
        ? ['correlation_id', 'workflow_template_id', 'workflow_run_id', 'tracking_number']
        : ['shipment_id', 'workflow_run_id', 'tracking_number'],
    );
    if (!dryRun) {
      requireLiveStringField(rec, ['shipment_id'], 'ui_create_shipment_v1 did not return shipment_id');
      requireLiveStringField(rec, ['workflow_run_id'], 'ui_create_shipment_v1 did not return workflow_run_id');
      requireLiveStringField(rec, ['tracking_number'], 'ui_create_shipment_v1 did not return tracking_number');
    }
    const result = normalizeUiCreateShipmentResult(rec, dryRun);
    if (!dryRun) {
      await requireLiveShipmentCreateReadback('ui_create_shipment_v1', args, result, rec);
    }
    return result;
  }

  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('ui_create_shipment_v1');
  await sleep(120);
  return seedCreateManualShipmentResult(args, dryRun);
}

export async function shipment_amend_cancel_v1(
  shipmentId: string,
  op: string | Record<string, unknown>,
  payload: Record<string, unknown> = {},
  opts: { dryRun?: boolean } = {},
): Promise<{
  ok: true;
  workflow_template: string;
  workflow_run_id: string;
  started_via: string;
  canonical_entrypoint: string;
  dry_run: boolean;
  diff: Record<string, unknown> | null;
  settings_resolution_id: string;
}> {
  const rawOp = typeof op === 'string' ? op : String((op as Record<string, unknown>).action ?? 'amend');
  const lookupBackendOperation = lookupCommandContractRow('shipment_amend_op', rawOp)?.metadata?.backend_operation;
  const operation =
    typeof lookupBackendOperation === 'string' && lookupBackendOperation.length > 0
      ? lookupBackendOperation
      : rawOp === 'amend_field' || rawOp === 'amend'
        ? 'modify'
        : rawOp;
  const effectivePayload = typeof op === 'string' ? payload : op;
  const mutationSource =
    typeof effectivePayload.source === 'string' && effectivePayload.source.trim()
      ? effectivePayload.source
      : null;
  const payloadWithoutSource =
    mutationSource && operation === 'modify'
      ? Object.fromEntries(Object.entries(effectivePayload).filter(([key]) => key !== 'source'))
      : effectivePayload;
  const inputPayload =
    payloadWithoutSource && (payloadWithoutSource.changes || payloadWithoutSource.address || payloadWithoutSource.destination_address)
      ? payloadWithoutSource
      : operation === 'address'
        ? { address: payloadWithoutSource }
        : operation === 'modify'
          ? { changes: payloadWithoutSource }
          : payloadWithoutSource;
  const live = await liveRpc<Record<string, unknown>>('shipment_amend_cancel_v1', {
    p_input: {
      shipment_id: shipmentId,
      operation,
      surface: 'console',
      dry_run: !!opts.dryRun,
      ...(mutationSource ? { source: mutationSource } : {}),
      ...inputPayload,
    },
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'Shipment mutation returned no backend outcome',
    );
    const outcomeError = backendOutcomeError(rec, 'Shipment mutation was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const dryRun = Boolean(rec.dry_run ?? opts.dryRun);
    const workflowRunId = asNonEmptyString(rec.workflow_run_id);
    let workflowTemplate = asNonEmptyString(
      rec.workflow_template ??
      rec.workflow_template_name ??
      rec.workflow_template_id,
    );
    if (!dryRun && !workflowRunId) {
      throw new Error('Shipment mutation did not return workflow_run_id');
    }
    if (!dryRun && !workflowTemplate && workflowRunId) {
      const workflowRun = await requireLiveResourceReadback('workflow_runs', workflowRunId, 'shipment_amend_cancel_v1');
      workflowTemplate = asNonEmptyString(
        workflowRun.workflow_template_name ??
        workflowRun.template_name ??
        workflowRun.workflow_template_id,
      );
    }
    if (!dryRun && !workflowTemplate) {
      throw new Error('Shipment mutation did not return workflow_template or readable workflow run template evidence');
    }
    if (!dryRun) {
      await requireLiveShipmentMutationReadback('shipment_amend_cancel_v1', {
        shipmentId,
        workflowRunId,
        operation,
        payload: inputPayload,
        result: rec,
        // Shipment operators may not have workflow-log read permission. The
        // RPC response carries workflow template/run evidence, while shipment
        // visibility is proven from shipment/domain readback below.
        requireWorkflowRunReadback: false,
      });
    }
    return {
      ...rec,
      ok: true,
      workflow_template: workflowTemplate ?? '',
      workflow_run_id: workflowRunId ?? '',
      started_via: String(rec.started_via ?? (dryRun ? 'dry_run_preview' : 'start_workflow_run')),
      canonical_entrypoint: String(rec.canonical_entrypoint ?? (dryRun ? 'not_started' : 'progress_workflow_run')),
      dry_run: dryRun,
      diff: (rec.diff as Record<string, unknown> | null | undefined) ?? null,
      settings_resolution_id: String(rec.settings_resolution_id ?? ''),
    };
  }

  await sleep(150);
  return {
    ok: true,
    workflow_template: 'tpl_amend_cancel',
    workflow_run_id: opts.dryRun ? '' : 'wfr_synthetic_' + Date.now(),
    started_via: opts.dryRun ? 'dry_run_preview' : 'start_workflow_run',
    canonical_entrypoint: opts.dryRun ? 'not_started' : 'progress_workflow_run',
    dry_run: !!opts.dryRun,
    diff: opts.dryRun ? { ...effectivePayload } : null,
    settings_resolution_id: 'srlv_' + Math.floor(Math.random() * 9000),
  };
}

export async function shipment_amend_cancel_options_v1(
  shipmentId: string,
): Promise<Record<string, unknown>> {
  const live = await liveRpc<Record<string, unknown>>('shipment_amend_cancel_options_v1', {
    p_shipment_id: shipmentId,
  });
  if (live) {
    return requireLiveRpcRecord(
      live.data,
      'Shipment operation policy returned no backend state',
    );
  }

  await sleep(60);
  const shipment = ((seed as { shipments?: Array<Record<string, unknown>> }).shipments ?? [])
    .find((row) => String(row.id ?? row.shipment_id ?? '') === shipmentId);
  const status = String(shipment?.status ?? 'unknown');
  const allowedStatuses = ['created', 'pending'];
  const isSeedPolicyEligible = Boolean(shipment) && allowedStatuses.includes(status);
  const guard = (operation: string) => ({
    operation,
    allowed: isSeedPolicyEligible,
    reason: isSeedPolicyEligible ? null : (shipment ? 'status_not_allowed' : 'backend_policy_unavailable'),
    lock_source: 'shipment_operation_policy',
    status,
    allowed_statuses: allowedStatuses,
  });

  return {
    shipment_id: shipmentId,
    tracking_number: shipment?.tracking_number ?? null,
    status,
    lock_source: 'shipment_operation_policy',
    policy: {},
    operations: {
      modify: guard('modify'),
      reschedule: guard('reschedule'),
      address: guard('address'),
      cancel: guard('cancel'),
    },
  };
}

function requireLiveManualShipmentIntakeResult(data: unknown, dryRun: boolean): Record<string, unknown> {
  const rpcName = 'ui_create_manual_shipment_intake_v1';
  const rec = requireLiveRpcRecord(data, `${rpcName} returned no backend outcome`);
  const outcomeError = backendOutcomeError(rec, `${rpcName} was rejected by the backend`);
  if (outcomeError) throw outcomeError;
  const promoted = promoteManualShipmentIntakeEvidence(rec, dryRun);
  const reusedManualIntake = isManualShipmentIntakeReuseResult(promoted);
  requireLiveEvidence(
    promoted,
    [
      ...(dryRun
        ? ['correlation_id', 'workflow_template_id', 'workflow_run_id', 'tracking_number']
        : reusedManualIntake
          ? ['shipment_id', 'tracking_number']
          : ['shipment_id', 'workflow_run_id', 'tracking_number']),
      ...LIVE_MUTATION_EVIDENCE_KEYS,
    ],
    `${rpcName} did not return backend execution evidence`,
  );
  return promoted;
}

async function requireLiveShipmentWorkflowReadback(
  rpcName: string,
  {
    shipmentId,
    workflowRunId,
    labelJobId,
  }: {
    shipmentId?: string | null;
    workflowRunId?: string | null;
    labelJobId?: string | null;
  },
): Promise<void> {
  const normalizedShipmentId = asNonEmptyString(shipmentId);
  const normalizedWorkflowRunId = asNonEmptyString(workflowRunId);
  const normalizedLabelJobId = asNonEmptyString(labelJobId);

  if (normalizedShipmentId) {
    await requireLiveResourceReadback('shipments', normalizedShipmentId, rpcName);
  }
  if (normalizedWorkflowRunId) {
    await requireLiveResourceReadback('workflow_runs', normalizedWorkflowRunId, rpcName);
  }
  if (normalizedLabelJobId) {
    await requireLiveResourceReadback('label_jobs', normalizedLabelJobId, rpcName);
  }
}

function normalizeSaShortAddress(value: unknown): string | null {
  const text = asNonEmptyString(value);
  if (!text) return null;
  return text.replace(/\s+/g, '').toUpperCase();
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      return objectRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return objectRecord(value);
}

function addressSubmissionCandidates(row: Record<string, unknown>): Array<Record<string, unknown>> {
  const rawInput = parseJsonRecord(row.raw_input);
  return [
    row,
    rawInput,
    objectRecord(rawInput.provided_coordinates),
    objectRecord(rawInput.coordinates),
    objectRecord(row.coordinates),
    objectRecord(row.geocoding_context),
    objectRecord(row.metadata),
  ];
}

function canonicalAddressReadbackCandidates(row: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    row,
    objectRecord(row.coordinates),
    objectRecord(row.geocoding_context),
    objectRecord(row.metadata),
  ];
}

function pickAddressShortCode(row: Record<string, unknown>, canonicalOnly = false): string | null {
  const candidates = canonicalOnly ? canonicalAddressReadbackCandidates(row) : addressSubmissionCandidates(row);
  for (const candidate of candidates) {
    for (const key of SA_SHORT_ADDRESS_READBACK_KEYS) {
      const normalized = normalizeSaShortAddress(candidate[key]);
      if (normalized) return normalized;
    }
  }
  return null;
}

function pickAddressCoordinate(row: Record<string, unknown>, axis: 'lat' | 'lng', canonicalOnly = false): number | null {
  const keys = axis === 'lat'
    ? ['latitude', 'lat', 'destination_latitude', 'dest_latitude']
    : ['longitude', 'lng', 'destination_longitude', 'dest_longitude'];
  const candidates = canonicalOnly ? canonicalAddressReadbackCandidates(row) : addressSubmissionCandidates(row);
  for (const candidate of candidates) {
    const directPair = coordinatePairFromUnknown(candidate.coordinates);
    if (directPair) return directPair[axis];
    for (const key of keys) {
      const value = _numberFromUnknown(candidate[key]);
      if (value != null) return value;
    }
  }
  return null;
}

function requireSubmittedAddressReadback(
  rpcName: string,
  submittedAddress: Record<string, unknown>,
  addressRow: Record<string, unknown>,
): void {
  const submittedShortCode = pickAddressShortCode(submittedAddress);
  if (submittedShortCode) {
    const readbackShortCode = pickAddressShortCode(addressRow, true);
    if (readbackShortCode !== submittedShortCode) {
      throw new Error(`${rpcName} backend address readback did not project Saudi short national address to canonical address fields`);
    }
  }

  const submittedLat = pickAddressCoordinate(submittedAddress, 'lat');
  const submittedLng = pickAddressCoordinate(submittedAddress, 'lng');
  if (submittedLat != null || submittedLng != null) {
    const readbackLat = pickAddressCoordinate(addressRow, 'lat', true);
    const readbackLng = pickAddressCoordinate(addressRow, 'lng', true);
    if (
      submittedLat == null ||
      submittedLng == null ||
      readbackLat == null ||
      readbackLng == null ||
      Math.abs(readbackLat - submittedLat) > 0.000001 ||
      Math.abs(readbackLng - submittedLng) > 0.000001
    ) {
      throw new Error(`${rpcName} backend address readback did not project provided coordinates to canonical address fields`);
    }
  }
}

async function requireLiveShipmentCreateReadback(
  rpcName: string,
  args: UiCreateShipmentArgs,
  result: UiCreateShipmentResult,
  rec: Record<string, unknown>,
): Promise<void> {
  const shipmentId = asNonEmptyString(result.shipment_id);
  if (!shipmentId) throw new Error(`${rpcName} did not return shipment_id`);

  const shipmentRow = await requireLiveResourceReadback('shipments', shipmentId, rpcName);
  await requireLiveResourceReadback('shipment_directory', shipmentId, rpcName);
  const shipmentMetadata = objectRecord(shipmentRow.metadata);
  const expectedBranchId = asNonEmptyString(shipmentMetadata.service_offering_branch_id);
  if (expectedBranchId && asNonEmptyString(shipmentRow.branch_id) !== expectedBranchId) {
    throw new Error(`${rpcName} backend readback did not project service_offering_branch_id to shipments.branch_id`);
  }
  const expectedZoneId = asNonEmptyString(shipmentMetadata.service_offering_zone_id);
  if (expectedZoneId && asNonEmptyString(shipmentRow.zone_id) !== expectedZoneId) {
    throw new Error(`${rpcName} backend readback did not project service_offering_zone_id to shipments.zone_id`);
  }
  const expectedServiceLevel = asNonEmptyString(shipmentMetadata.service_level_key);
  const actualServiceLevel = asNonEmptyString(shipmentRow.service_level);
  if (
    expectedServiceLevel &&
    (!actualServiceLevel || actualServiceLevel.toLowerCase() !== expectedServiceLevel.toLowerCase())
  ) {
    throw new Error(`${rpcName} backend readback did not project service_level_key to shipments.service_level`);
  }

  const workflowRunId = asNonEmptyString(result.workflow_run_id);
  if (workflowRunId) {
    await requireLiveResourceReadback('workflow_runs', workflowRunId, rpcName);
  }

  const recipientId =
    asNonEmptyString(result.recipient_id) ??
    asNonEmptyString(args.recipient_id) ??
    asNonEmptyString(shipmentRow.recipient_id);
  if (args.new_recipient && !recipientId) {
    throw new Error(`${rpcName} did not return recipient_id for inline recipient readback`);
  }
  if (recipientId) {
    await requireLiveResourceReadback('recipients', recipientId, rpcName);
    await requireLiveResourceReadback('recipient_directory', recipientId, rpcName);
  }

  const duplicateReuse = isManualShipmentIntakeReuseResult(rec);
  if (args.destination_address && !duplicateReuse) {
    const addressResult = objectRecord(rec.address_result);
    const destinationAddressId =
      asNonEmptyString(shipmentRow.destination_address_id) ??
      asNonEmptyString(rec.destination_address_id) ??
      asNonEmptyString(rec.address_id) ??
      asNonEmptyString(addressResult.destination_address_id) ??
      asNonEmptyString(addressResult.address_id);
    if (!destinationAddressId) {
      throw new Error(`${rpcName} did not expose destination_address_id for address readback`);
    }
    const addressRow = await requireLiveResourceReadback('addresses', destinationAddressId, rpcName);
    requireSubmittedAddressReadback(rpcName, args.destination_address, addressRow);
  } else if (args.destination_address) {
    const destinationAddressId = asNonEmptyString(shipmentRow.destination_address_id);
    if (destinationAddressId) {
      const addressRow = await requireLiveResourceReadback('addresses', destinationAddressId, rpcName);
      requireSubmittedAddressReadback(rpcName, args.destination_address, addressRow);
    }
  }

  const labelJobId = asNonEmptyString(result.label_job_id);
  if (labelJobId) {
    const labelJob = await requireLiveResourceReadback('label_jobs', labelJobId, rpcName);
    const labelId =
      asNonEmptyString(rec.label_id) ??
      asNonEmptyString(labelJob.label_id);
    if (labelId) {
      await requireLiveResourceReadback('labels', labelId, rpcName);
    }
    const labelVersionId =
      asNonEmptyString(rec.label_version_id) ??
      asNonEmptyString(labelJob.label_version_id) ??
      asNonEmptyString(labelJob.active_version_id);
    if (labelVersionId) {
      await requireLiveResourceReadback('label_versions', labelVersionId, rpcName);
    }
  }
}

async function requireLiveShipmentMutationReadback(
  rpcName: string,
  {
    shipmentId,
    workflowRunId,
    labelJobId,
    operation,
    payload,
    result,
    requireWorkflowRunReadback = true,
  }: {
    shipmentId?: string | null;
    workflowRunId?: string | null;
    labelJobId?: string | null;
    operation?: string | null;
    payload?: Record<string, unknown> | null;
    result?: Record<string, unknown> | null;
    requireWorkflowRunReadback?: boolean;
  },
): Promise<void> {
  const normalizedShipmentId = asNonEmptyString(shipmentId);
  const shipmentRow = normalizedShipmentId
    ? await requireLiveResourceReadback('shipments', normalizedShipmentId, rpcName)
    : {};
  if (normalizedShipmentId) {
    await requireLiveResourceReadback('shipment_directory', normalizedShipmentId, rpcName);
  }
  const normalizedWorkflowRunId = asNonEmptyString(workflowRunId);
  if (normalizedWorkflowRunId && requireWorkflowRunReadback) {
    await requireLiveResourceReadback('workflow_runs', normalizedWorkflowRunId, rpcName);
  }
  const normalizedLabelJobId = asNonEmptyString(labelJobId);
  if (normalizedLabelJobId) {
    await requireLiveResourceReadback('label_jobs', normalizedLabelJobId, rpcName);
  }

  const normalizedPayload = objectRecord(payload);
  const normalizedResult = objectRecord(result);
  const operationResult = objectRecord(normalizedResult.operation_result);
  const reserveResult = objectRecord(operationResult.reserve_result);
  const actionId =
    asNonEmptyString(normalizedResult.shipment_action_id) ??
    asNonEmptyString(operationResult.shipment_action_id) ??
    asNonEmptyString(reserveResult.action_id) ??
    asNonEmptyString(normalizedResult.action_id);
  if (actionId) {
    await requireLiveResourceReadback('shipment_actions', actionId, rpcName);
  }
  const addressPayload = objectRecord(normalizedPayload.address);
  const destinationAddressPayload = objectRecord(normalizedPayload.destination_address);
  const touchesAddress =
    operation === 'address' ||
    Object.keys(addressPayload).length > 0 ||
    Object.keys(destinationAddressPayload).length > 0;
  if (touchesAddress) {
    const addressResult = objectRecord(normalizedResult.address_result);
    const destinationAddressId =
      asNonEmptyString(normalizedResult.destination_address_id) ??
      asNonEmptyString(normalizedResult.address_id) ??
      asNonEmptyString(operationResult.destination_address_id) ??
      asNonEmptyString(operationResult.address_id) ??
      asNonEmptyString(addressResult.destination_address_id) ??
      asNonEmptyString(addressResult.address_id) ??
      asNonEmptyString(shipmentRow.destination_address_id);
    if (!destinationAddressId) {
      throw new Error(`${rpcName} did not expose destination_address_id for address readback`);
    }
    await requireLiveResourceReadback('addresses', destinationAddressId, rpcName);
    const geocodeWorkflowRunId =
      asNonEmptyString(operationResult.geocode_workflow_run_id) ??
      asNonEmptyString(operationResult.address_workflow_run_id);
    if (geocodeWorkflowRunId) {
      await requireLiveResourceReadback('workflow_runs', geocodeWorkflowRunId, rpcName);
    }
  }

  const changes = objectRecord(normalizedPayload.changes);
  const boxes = objectRecord(changes.boxes);
  const boxIds = new Set<string>();
  for (const boxId of Object.keys(boxes)) {
    const normalizedBoxId = asNonEmptyString(boxId);
    if (normalizedBoxId) boxIds.add(normalizedBoxId);
  }
  const returnedBoxId =
    asNonEmptyString(normalizedResult.shipment_box_id) ??
    asNonEmptyString(normalizedResult.box_id) ??
    asNonEmptyString(normalizedResult.target_box_id);
  if (returnedBoxId) boxIds.add(returnedBoxId);
  for (const boxId of boxIds) {
    await requireLiveResourceReadback('shipment_boxes', boxId, rpcName);
  }

  const touchesCod = ['cod_amount', 'cod_currency', 'cod_method', 'payment_collection_method'].some((key) =>
    Object.prototype.hasOwnProperty.call(changes, key) ||
    Object.prototype.hasOwnProperty.call(normalizedPayload, key),
  );
  if (touchesCod) {
    const actionId =
      asNonEmptyString(normalizedResult.shipment_action_id) ??
      asNonEmptyString(normalizedResult.action_id) ??
      asNonEmptyString(normalizedResult.cod_action_id);
    if (actionId) {
      await requireLiveResourceReadback('shipment_actions', actionId, rpcName);
    }
  }
}

export async function ui_execute_shipment_resort_v1(shipmentId: string): Promise<ShipmentResortResult> {
  const live = await liveRpc<Record<string, unknown>>('ui_execute_shipment_resort_v1', {
    p_action_key: 'shipments.resort',
    p_resource_key: 'shipments',
    p_selection_ids: [shipmentId],
    p_selection_id: shipmentId,
    p_selection_count: 1,
    p_params: {},
  });
  if (live) {
    const rec = requireLiveRpcRecord(
      live.data,
      'Shipment resort returned no backend outcome',
    );
    const error = backendOutcomeError(rec, 'Shipment resort was rejected by the backend');
    if (error) throw error;
    await requireLiveShipmentWorkflowReadback('ui_execute_shipment_resort_v1', {
      shipmentId,
      workflowRunId: asNonEmptyString(rec.workflow_run_id),
    });
    return {
      ok: true,
      basket_policy_applied: true,
      ...rec,
    } as ShipmentResortResult;
  }

  await sleep(80);
  return { ok: true, basket_policy_applied: true };
}

export async function ui_execute_shipment_update_geocode_v1(
  shipmentId: string,
  params: Record<string, unknown> = {},
): Promise<ShipmentUpdateGeocodeResult> {
  if (!shipmentId) throw new Error('shipment_id is required to requeue geocoding');

  const live = await liveRpc<Record<string, unknown>>('ui_execute_shipment_update_geocode_v1', {
    p_action_key: 'shipments.update_geocode',
    p_resource_key: 'shipments',
    p_selection_ids: [shipmentId],
    p_selection_id: shipmentId,
    p_selection_count: 1,
    p_params: {
      workflow_template_name: 'shipment_update_geocode_v1',
      ...params,
    },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_shipment_update_geocode_v1', [
      'workflow_run_id',
    ]);
    const workflowRunId = requireLiveStringField(
      rec,
      ['workflow_run_id'],
      'ui_execute_shipment_update_geocode_v1 did not return workflow_run_id',
    );
    await requireLiveShipmentWorkflowReadback('ui_execute_shipment_update_geocode_v1', {
      shipmentId,
      workflowRunId,
    });
    const itemRecords = Array.isArray(rec.items) ? (rec.items as Array<Record<string, unknown>>) : [];
    const firstItemString = (keys: readonly string[]): string | null => {
      for (const item of itemRecords) {
        for (const key of keys) {
          const value = asNonEmptyString(item[key]);
          if (value) return value;
        }
      }
      return null;
    };
    const geocodeWorkflowStatus = (
      asNonEmptyString(rec.geocode_workflow_status)
      ?? firstItemString(['geocode_workflow_status'])
    )?.toLowerCase();
    const geocodeWorkflowRunId =
      asNonEmptyString(rec.geocode_workflow_run_id) ??
      firstItemString(['geocode_workflow_run_id']);
    if (geocodeWorkflowStatus && ['failed', 'cancelled', 'blocked'].includes(geocodeWorkflowStatus)) {
      throw new Error(
        `ui_execute_shipment_update_geocode_v1 nested geocode workflow ${geocodeWorkflowStatus}`
        + (geocodeWorkflowRunId ? ` (${geocodeWorkflowRunId})` : ''),
      );
    }
    if (geocodeWorkflowRunId) {
      await requireLiveResourceReadback('workflow_runs', geocodeWorkflowRunId, 'ui_execute_shipment_update_geocode_v1');
    }
    const geocodingAttemptId =
      asNonEmptyString(rec.geocoding_attempt_id) ??
      asNonEmptyString(rec.attempt_id) ??
      firstItemString(['geocoding_attempt_id', 'attempt_id']);
    const geocodeId =
      asNonEmptyString(rec.geocode_id) ??
      firstItemString(['geocode_id']);
    const manualReviewTaskId =
      asNonEmptyString(rec.manual_review_task_id) ??
      asNonEmptyString(rec.review_task_id) ??
      asNonEmptyString(rec.task_id) ??
      firstItemString(['manual_review_task_id', 'review_task_id', 'task_id']);
    if (geocodingAttemptId) {
      await requireLiveResourceReadback('geocoding_attempts', geocodingAttemptId, 'ui_execute_shipment_update_geocode_v1');
    }
    if (geocodeId) {
      await requireLiveResourceReadback('geocodes', geocodeId, 'ui_execute_shipment_update_geocode_v1');
    }
    if (manualReviewTaskId) {
      await requireLiveResourceReadback('manual_review_tasks', manualReviewTaskId, 'ui_execute_shipment_update_geocode_v1');
    }
    return {
      ok: true,
      status: String(rec.status ?? 'workflow_started'),
      action_key: String(rec.action_key ?? 'shipments.update_geocode'),
      resource_key: String(rec.resource_key ?? 'shipments'),
      count: Number(rec.count ?? 1),
      workflow_run_id: workflowRunId,
      items: Array.isArray(rec.items) ? (rec.items as Array<Record<string, unknown>>) : undefined,
      ...rec,
    } as ShipmentUpdateGeocodeResult;
  }

  await sleep(80);
  const workflowRunId = 'wfr_geocode_' + Date.now();
  return {
    ok: true,
    status: 'completed',
    action_key: 'shipments.update_geocode',
    resource_key: 'shipments',
    count: 1,
    workflow_run_id: workflowRunId,
    items: [
      {
        shipment_id: shipmentId,
        address_id: typeof params.address_id === 'string' ? params.address_id : null,
        destination_address_id:
          typeof params.destination_address_id === 'string' ? params.destination_address_id : null,
        workflow_run_id: workflowRunId,
        status: 'completed',
      },
    ],
  };
}

export async function ui_execute_shipment_batch_operation_v1(
  ids: string[],
  op: string,
  payload: Record<string, unknown>,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: true; count: number; op: string; dry_run: boolean }> {
  const operation = op === 'delete' ? 'cancel' : op;
  let actionKey: 'shipments.delete' | 'shipments.reschedule';
  if (operation === 'cancel') {
    actionKey = 'shipments.delete';
  } else if (operation === 'reschedule') {
    actionKey = 'shipments.reschedule';
  } else {
    throw new Error(`ui_execute_shipment_batch_operation_v1 unsupported operation ${operation}`);
  }
  const live = await liveRpc<Record<string, unknown>>('ui_execute_shipment_batch_operation_v1', {
    p_action_key: actionKey,
    p_resource_key: 'shipments',
    p_selection_ids: ids,
    p_selection_id: ids.length === 1 ? ids[0] : null,
    p_selection_count: ids.length,
    p_params: {
      ...payload,
      operation,
      surface: 'console',
      dry_run: !!opts.dryRun,
    },
  });
  if (live) {
    const rec = requireLiveMutationResult(live.data, 'ui_execute_shipment_batch_operation_v1', [
      'workflow_run_id',
      'items',
      'count',
      'success_count',
      'affected_count',
    ]);
    const count = requireLiveNumberField(
      rec,
      ['count', 'success_count', 'affected_count'],
      'Shipment batch operation did not return an affected count',
    );
    if (!opts.dryRun) {
      for (const id of ids) {
        await requireLiveResourceReadback('shipments', id, 'ui_execute_shipment_batch_operation_v1');
      }
      const workflowRunId = asNonEmptyString(rec.workflow_run_id);
      if (workflowRunId) {
        await requireLiveResourceReadback('workflow_runs', workflowRunId, 'ui_execute_shipment_batch_operation_v1');
      }
    }
    return {
      ...rec,
      ok: true,
      count,
      op: operation,
      dry_run: !!opts.dryRun,
    } as { ok: true; count: number; op: string; dry_run: boolean };
  }

  await sleep(120);
  return { ok: true, count: ids.length, op, dry_run: !!opts.dryRun };
}

export async function list_delivery_slots_v1(
  args?: { shipment_id?: string; slot_date?: string } | unknown,
): Promise<DeliverySlotWindow[]> {
  const input = ((args ?? {}) as Record<string, unknown>);
  const shipmentId = input.shipment_id as string | undefined;
  const clientId = (input.client_id as string | undefined) ?? await getLiveShipmentClientId(shipmentId);
  const live = await liveRpc('list_delivery_slots_v1', {
    p_input: {
      ...input,
      client_id: clientId,
      start_date: input.start_date ?? input.slot_date,
      days: input.days ?? 1,
      include_unavailable: input.include_unavailable ?? false,
    },
  });
  if (live) {
    const rows = Array.isArray(live.data) ? live.data : [];
    return rows.map((row) => normalizeDeliverySlotWindow(row as Record<string, unknown>));
  }

  await sleep(40);
  const slotDate = (args as { slot_date?: string } | undefined)?.slot_date;
  if (slotDate) {
    const scoped = DELIVERY_SLOT_CATALOG.filter((w) => w.slot_date === slotDate);
    if (scoped.length) return scoped;
    // Synthesize 3 windows for any date the operator picks so the picker
    // always has something to render — matches the RPC's "always returns
    // policy-resolved windows" contract.
    return [
      { window_id: `win_${slotDate}_am`, slot_date: slotDate, window_start_local: '10:00', window_end_local: '12:00', remaining: 10 },
      { window_id: `win_${slotDate}_mid`, slot_date: slotDate, window_start_local: '13:00', window_end_local: '15:00', remaining: 6 },
      { window_id: `win_${slotDate}_pm`, slot_date: slotDate, window_start_local: '16:00', window_end_local: '18:00', remaining: 3 },
    ];
  }
  return DELIVERY_SLOT_CATALOG;
}
