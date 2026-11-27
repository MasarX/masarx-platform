// Shipment drawer tabs that load only when an operator opens them (evidence, boxes, baskets,
// recipient, COD, route, tasks and comms), so the shipments page chunk stays small.
import { useMemo, useState } from 'react';
import { Button } from '@/components/Button';
import { DataTable } from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useResourceListsByFilters,
  useResourceRowsByIds,
  useShipmentAmendCancel,
  useResolveSettings,
  useTransitionTask,
  useEnqueueCommsAttempt,
  useRecipientUpdate,
} from '@/lib/queries';
import { useCapability } from '@/lib/identity';
import { fill, useI18n, useT } from '@/lib/i18n';
import * as api from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import { compactReference, firstText } from './shipment-display';
import {
  basketDirectZoneLabel,
  basketRelationLabel,
  basketZoneLabel,
  canEditShipmentTaskStatus,
  isCompletedRouteStopEvidenceTask,
  isPermissionDeniedError,
  latestCodPaymentProjection,
  lookupDisplayValue,
  operatorActorLabel,
  podEvidenceProjectionFromRow,
  resolveShipmentTaskTarget,
  titleCaseKey,
  type Shipment,
  type ShipmentActionPaymentRow,
  type ShipmentPodEvidenceProjection,
} from './shipments';

export function EvidenceTab({ shipment }: { shipment: Shipment }) {
  const { t, fmtCurrency, fmtDateTime } = useI18n();
  const actionsQuery = useResourceList<Record<string, unknown>>('shipment_actions', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'timestamp', dir: 'desc' },
    page_size: 25,
  });
  const tasksQuery = useResourceList<Record<string, unknown>>('tasks', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'updated_at', dir: 'desc' },
    page_size: 50,
  });

  if (actionsQuery.isLoading || tasksQuery.isLoading) return <StateView kind="loading" />;
  const actionsError = actionsQuery.error ?? null;
  const tasksError = tasksQuery.error ?? null;
  const bothEvidenceStreamsFailed = Boolean(actionsError && tasksError);
  if (bothEvidenceStreamsFailed) {
    const error = actionsError ?? tasksError;
    if (error && isPermissionDeniedError(error)) {
      return (
        <StateView
          kind="denied"
          title={t('shipments.evidence.proofOfDeliveryUnavailable')}
          hint={t('shipments.evidence.evidenceReadsRequireShipmentAction')}
        />
      );
    }
    return <StateView kind="error" title={t('shipments.evidence.proofOfDeliveryUnavailable')} hint={(error as Error | null)?.message} />;
  }
  const partialError = actionsError ?? tasksError;

  const evidence = [
    ...(!actionsError ? actionsQuery.data?.rows ?? [] : [])
      .map((row) => podEvidenceProjectionFromRow(row, 'shipment_action', t)),
    ...(!tasksError ? tasksQuery.data?.rows ?? [] : [])
      .filter(isCompletedRouteStopEvidenceTask)
      .map((row) => podEvidenceProjectionFromRow(row, 'task_closeout', t)),
  ]
    .filter((row): row is ShipmentPodEvidenceProjection => Boolean(row))
    .sort((a, b) => {
      const at = Date.parse(String(a.capturedAt ?? a.occurredAt ?? ''));
      const bt = Date.parse(String(b.capturedAt ?? b.occurredAt ?? ''));
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });

  if (!evidence.length) {
    return (
      <div className="state__hint" style={{ padding: '6px 14px' }}>
        {t('shipments.evidence.noProofOfDeliveryHas')}
      </div>
    );
  }

  const latest = evidence[0];
  const geostampText = latest.geostamp
    ? [
        firstText(latest.geostamp.latitude, latest.geostamp.lat),
        firstText(latest.geostamp.longitude, latest.geostamp.lng),
      ]
        .filter(Boolean)
        .join(', ')
    : t('shipments.evidence.notCaptured');
  const identityText = latest.identityKind || latest.identityLast4
    ? `${lookupDisplayValue('recipient_identity_kind', latest.identityKind, titleCaseKey(latest.identityKind, undefined, t))}${latest.identityLast4 ? fill(t('shipments.evidence.identityEnding'), { last4: latest.identityLast4 }) : ''}`
    : t('shipments.evidence.notCaptured');
  const artifactSummary = latest.artifactIds.length
    ? fill(
      latest.artifactIds.length === 1 ? t('shipments.evidence.artifactsLinkedOne') : t('shipments.evidence.artifactsLinkedOther'),
      { count: latest.artifactIds.length },
    )
    : t('shipments.evidence.noArtifactBundle');
  const payment = latest.paymentCollection ?? null;
  const paymentCurrency = payment?.currency ?? shipment.cod_currency ?? '';
  const paymentOutcome = payment?.outcome
    ? lookupDisplayValue('payment_collection_outcome', payment.outcome, titleCaseKey(payment.outcome, undefined, t))
    : t('shipments.evidence.notRequired');
  const paymentMethod = payment?.method
    ? lookupDisplayValue('payment_collection_method', payment.method, titleCaseKey(payment.method, undefined, t))
    : t('shipments.common.notRecorded');
  const paymentExpected = payment?.expectedAmount == null
    ? t('shipments.common.notRecorded')
    : fmtCurrency(payment.expectedAmount, paymentCurrency);
  const paymentCollected = payment?.collectedAmount == null
    ? t('shipments.common.notRecorded')
    : fmtCurrency(payment.collectedAmount, paymentCurrency);
  const paymentVariance = payment?.varianceAmount == null
    ? t('shipments.common.notRecorded')
    : fmtCurrency(payment.varianceAmount, paymentCurrency);
  const rows: KvRow[] = [
    { key: 'handover_mode', label: t('shipments.evidence.handover'), value: lookupDisplayValue('delivery_handover_mode', latest.handoverMode, t('shipments.common.notRecorded')), editable: false },
    { key: 'recipient_name', label: t('shipments.common.recipient'), value: latest.recipientName ?? latest.recipientClass ?? t('shipments.common.notRecorded'), editable: false },
    { key: 'identity', label: t('shipments.evidence.identityProof'), value: identityText, editable: false },
    { key: 'otp', label: t('shipments.evidence.otp'), value: latest.otpLast4 ? fill(t('shipments.evidence.confirmedEndingOtplast4'), { otpLast4: String(latest.otpLast4) }) : latest.otpConfirmed ? t('shipments.common.confirmed') : t('shipments.evidence.notCaptured'), editable: false },
    { key: 'signature', label: t('shipments.evidence.recipientSignature'), value: latest.signatureArtifactId ? compactReference(latest.signatureArtifactId, t('shipments.evidence.artifact')) : t('shipments.evidence.notLinked'), editable: false },
    { key: 'photo', label: t('shipments.evidence.proofPhoto'), value: latest.photoArtifactId ? compactReference(latest.photoArtifactId, t('shipments.evidence.artifact')) : t('shipments.evidence.notLinked'), editable: false },
    { key: 'artifact_bundle', label: t('shipments.evidence.artifactBundle'), value: artifactSummary, editable: false },
    { key: 'payment_outcome', label: t('shipments.evidence.paymentOutcome'), value: paymentOutcome, editable: false },
    { key: 'payment_method', label: t('shipments.evidence.paymentMethod'), value: paymentMethod, editable: false },
    { key: 'payment_expected', label: t('shipments.evidence.codExpected'), value: paymentExpected, mono: payment?.expectedAmount != null, editable: false },
    { key: 'payment_collected', label: t('shipments.evidence.codCollected'), value: paymentCollected, mono: payment?.collectedAmount != null, editable: false },
    { key: 'payment_variance', label: t('shipments.evidence.codVariance'), value: paymentVariance, mono: payment?.varianceAmount != null, editable: false },
    { key: 'payment_discrepancy', label: t('shipments.evidence.codDiscrepancy'), value: payment?.discrepancyKind ? titleCaseKey(payment.discrepancyKind, undefined, t) : t('shipments.common.notRecorded'), editable: false },
    { key: 'payment_receipt', label: t('shipments.evidence.receiptContext'), value: payment?.receiptContext ?? t('shipments.common.notRecorded'), editable: false },
    { key: 'geostamp', label: t('shipments.evidence.geostamp'), value: geostampText, mono: geostampText !== t('shipments.evidence.notCaptured'), editable: false },
    { key: 'route_stop_id', label: t('shipments.evidence.routeStop'), value: latest.routeStopId ? compactReference(latest.routeStopId, t('shipments.evidence.stop')) : t('shipments.evidence.notLinked'), mono: Boolean(latest.routeStopId), editable: false },
    { key: 'captured_at', label: t('shipments.evidence.captured'), value: latest.capturedAt ? fmtDateTime(latest.capturedAt) : t('shipments.evidence.notCaptured'), editable: false },
    { key: 'source', label: t('shipments.common.source'), value: latest.sourceLabel, editable: false },
  ];

  return (
    <div className="rail-body" style={{ paddingTop: 0 }} data-testid="shipment-evidence-tab">
      <h4 className="eyebrow">{t('shipments.evidence.proofOfDelivery')}</h4>
      {partialError ? (
        <div className="state__hint" data-testid="shipment-evidence-partial-read" style={{ padding: '0 14px 8px' }}>
          {isPermissionDeniedError(partialError)
            ? t('shipments.evidence.someEvidenceStreamsAreHidden')
            : fill(t('shipments.evidence.someEvidenceStreamsAreUnavailable'), { message: String((partialError as Error).message) })}
        </div>
      ) : null}
      <KvGrid rows={rows} />
      {latest.artifactIds.length ? (
        <div data-testid="shipment-evidence-artifacts" style={{ padding: '6px 14px 10px', display: 'grid', gap: 6 }}>
          <h4 className="eyebrow" style={{ margin: 0 }}>{t('shipments.evidence.artifacts')}</h4>
          {latest.artifactIds.map((artifactId) => (
            <div key={artifactId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span className="mono">{compactReference(artifactId, t('shipments.evidence.artifact'))}</span>
              <Button
                label={t('shipments.evidence.copyId')}
                iconName="copy"
                kind="ghost"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard?.writeText(artifactId);
                  pushToast(t('shipments.evidence.artifactIdCopied'), 'good');
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
      {latest.notes ? (
        <div className="state__hint" style={{ padding: '6px 14px 10px' }}>
          {latest.notes}
        </div>
      ) : null}
      <DataTable
        columns={[
          { key: 'captured', label: t('shipments.evidence.captured') },
          { key: 'handover', label: t('shipments.evidence.handover') },
          { key: 'recipient', label: t('shipments.common.recipient') },
          { key: 'artifacts', label: t('shipments.evidence.artifacts') },
          { key: 'source', label: t('shipments.common.source') },
        ]}
        rows={evidence.map((item) => ({
          id: item.id,
          captured: item.capturedAt ? fmtDateTime(item.capturedAt) : item.occurredAt ? fmtDateTime(item.occurredAt) : t('shipments.evidence.notCaptured'),
          handover: lookupDisplayValue('delivery_handover_mode', item.handoverMode, t('shipments.common.notRecorded')),
          recipient: item.recipientName ?? item.recipientClass ?? t('shipments.common.notRecorded'),
          artifacts: item.artifactIds.length ? String(item.artifactIds.length) : t('common.none'),
          source: item.sourceLabel,
        }))}
        allowSelection={false}
        emptyText={t('shipments.evidence.noProofEvidenceRowsFound')}
      />
    </div>
  );
}

export function BoxesTab({ shipmentId }: { shipmentId: string }) {
  const t = useT();
  // CLAIM-OPERATIONS-WIRING (Phase C1) — read seam moved from `api.seed.*` to
  // canonical resource registry (`ui_list_resource_v1('shipment_boxes')`).
  // Production swap: same call site reads from public.shipment_boxes via
  // ui_read_registry projection.
  //
  // W16-1 — closes OPERATIONS D3 §5/§6 (BoxesTab orphan cell-edit). Wires
  // box cell-edits through `shipment_amend_cancel_v1(op='modify')` with the
  // canonical workflow handler routing changes under
  // `changes.boxes.{box_id}.{key}`. Per the canonical contract
  // (`shipment_modify_v1` workflow template, migration 202603191030 line 30)
  // box-level metadata propagates through the same modify seam used for
  // recipient/COD edits — no per-field op alias required.
  const { data, isLoading, error } = useResourceList<Record<string, unknown>>('shipment_boxes', {
    filter: { shipment_id: shipmentId },
  });
  if (isLoading) return <StateView kind="loading" />;
  if (error) return <StateView kind="error" hint={(error as Error).message} />;
  const boxes = data?.rows ?? [];
  return (
    <DataTable
      columns={[
        { key: 'box_number', label: '#', sortable: true },
        { key: 'barcode', label: t('shipments.common.barcode'), mono: true, sortable: true, filterable: true },
        { key: 'weight_kg', label: t('shipments.boxes.weightKg'), align: 'right', type: 'number' },
        { key: 'fragile', label: t('shipments.boxes.fragile'), type: 'boolean' },
      ]}
      rows={boxes}
      allowSelection={false}
      emptyText={t('shipments.boxes.noBoxesRecordedForThis')}
    />
  );
}

export function BasketsTab({ shipmentId }: { shipmentId: string }) {
  const { t, fmtDateTime } = useI18n();
  const [selectedBasketId, setSelectedBasketId] = useState<string | null>(null);
  const itemsQuery = useResourceList<Record<string, unknown>>('basket_items', {
    filter: { shipment_id: shipmentId },
    sort: { key: 'added_at', dir: 'desc' },
    page_size: 500,
  });
  const items = useMemo(() => itemsQuery.data?.rows ?? [], [itemsQuery.data]);
  const basketIds = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((item) => (typeof item.basket_id === 'string' ? item.basket_id : ''))
            .filter(Boolean),
        ),
      ).sort(),
    [items],
  );
  const basketsQuery = useResourceRowsByIds<Record<string, unknown>>('baskets', basketIds, {
    enabled: basketIds.length > 0,
  });
  const basketRows = useMemo(() => basketsQuery.data?.rows ?? [], [basketsQuery.data]);
  const basketZoneIds = useMemo(
    () =>
      Array.from(
        new Set(
          basketRows
            .filter((basket) => !basketDirectZoneLabel(basket))
            .map((basket) => firstText(basket.zone_id))
            .filter((zoneId): zoneId is string => Boolean(zoneId)),
        ),
      ).sort(),
    [basketRows],
  );
  const zonesQuery = useResourceRowsByIds<Record<string, unknown>>('zones', basketZoneIds, {
    enabled: basketZoneIds.length > 0,
  });
  const transitionsQuery = useResourceListsByFilters<Record<string, unknown>>(
    'basket_transitions',
    basketIds.map((basketId) => ({ basket_id: basketId })),
    { sort: { key: 'changed_at', dir: 'desc' }, page_size: 500 },
    { enabled: basketIds.length > 0 },
  );

  if (
    itemsQuery.isLoading ||
    (basketIds.length > 0 && basketsQuery.isLoading) ||
    (basketZoneIds.length > 0 && zonesQuery.isLoading) ||
    (basketIds.length > 0 && transitionsQuery.isLoading)
  ) {
    return <StateView kind="loading" />;
  }

  const error = itemsQuery.error ?? basketsQuery.error ?? zonesQuery.error ?? transitionsQuery.error;
  if (error) {
    if (isPermissionDeniedError(error)) {
      return (
        <StateView
          kind="denied"
          title={t('shipments.baskets.basketAssignmentsUnavailable')}
          hint={t('shipments.baskets.basketRelationshipReadsRequireBasket')}
        />
      );
    }
    return <StateView kind="error" title={t('shipments.baskets.basketAssignmentsUnavailable')} hint={(error as Error).message} />;
  }

  if (!items.length) {
    return <div className="state__hint">{t('shipments.baskets.noBasketAssignmentRecordedFor')}</div>;
  }

  const basketById = new Map(basketRows.map((basket) => [String(basket.id), basket]));
  const zoneById = new Map((zonesQuery.data?.rows ?? []).map((zone) => [String(zone.id), zone]));
  const rows: Array<Record<string, unknown>> = items.map((item) => {
    const basket = basketById.get(String(item.basket_id ?? ''));
    const zoneLabel = basketZoneLabel(basket, zoneById);
    return {
      ...item,
      basket_label: basketRelationLabel(basket, zoneLabel, t),
      basket_type: basket?.basket_type,
      state: basket?.state,
      zone_label: zoneLabel ?? t('shipments.baskets.zoneNotLinked'),
      current_count: basket?.current_count,
      capacity_count: basket?.capacity_count,
      expires_at: basket?.expires_at,
    };
  });
  const activeBasketId = selectedBasketId && basketIds.includes(selectedBasketId)
    ? selectedBasketId
    : String(rows[0]?.basket_id ?? '');
  const selectedRow = rows.find((row) => String(row.basket_id ?? '') === activeBasketId) ?? rows[0];
  const selectedBasket = basketById.get(String(selectedRow?.basket_id ?? ''));
  const relationshipRows: KvRow[] = selectedRow
    ? [
        { key: 'basket_label', label: t('shipments.baskets.basket'), value: selectedRow.basket_label },
        { key: 'basket_type', label: t('shipments.common.type'), value: selectedRow.basket_type, lookup: 'basket_type' },
        { key: 'state', label: t('shipments.baskets.state'), value: selectedRow.state, lookup: 'basket_state' },
        { key: 'zone_label', label: t('shipments.baskets.zone'), value: selectedRow.zone_label },
        {
          key: 'capacity',
          label: t('shipments.baskets.capacity'),
          value: `${selectedRow.current_count ?? 0}/${selectedRow.capacity_count ?? t('shipments.baskets.capacityNotSet')}`,
          mono: true,
        },
        {
          key: 'relationship_status',
          label: t('shipments.baskets.relationship'),
          value: selectedRow.removed_at ? t('shipments.baskets.removedFromBasket') : t('shipments.baskets.activeAssignment'),
        },
        { key: 'added_at', label: t('shipments.baskets.added'), value: fmtDateTime(String(selectedRow.added_at ?? '')) },
        { key: 'removed_at', label: t('shipments.baskets.removed'), value: selectedRow.removed_at ? fmtDateTime(String(selectedRow.removed_at)) : t('shipments.baskets.active') },
        {
          key: 'expires_at',
          label: t('shipments.baskets.expires'),
          value: selectedBasket?.expires_at ? fmtDateTime(String(selectedBasket.expires_at)) : t('shipments.baskets.noExpiryRecorded'),
        },
      ]
    : [];
  const transitions: Array<Record<string, unknown>> = (transitionsQuery.data?.rows ?? [])
    .filter((transition) => !activeBasketId || String(transition.basket_id ?? '') === activeBasketId)
    .map((transition): Record<string, unknown> => ({
      ...transition,
      basket_label: (() => {
        const basket = basketById.get(String(transition.basket_id ?? ''));
        return basketRelationLabel(basket, basketZoneLabel(basket, zoneById), t);
      })(),
      actor_label: operatorActorLabel(transition.changed_by, t),
    }))
    .sort((a, b) => String(b['changed_at'] ?? '').localeCompare(String(a['changed_at'] ?? '')));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <DataTable
        columns={[
          { key: 'basket_label', label: t('shipments.baskets.basket'), sortable: true, filterable: true },
          { key: 'basket_type', label: t('shipments.common.type'), lookup: 'basket_type', sortable: true, filterable: true },
          { key: 'state', label: t('shipments.baskets.state'), lookup: 'basket_state', sortable: true, filterable: true },
          { key: 'zone_label', label: t('shipments.baskets.zone'), sortable: true, filterable: true },
          { key: 'current_count', label: t('shipments.baskets.count'), type: 'number', align: 'right' },
          { key: 'capacity_count', label: t('shipments.baskets.capacity'), type: 'number', align: 'right' },
          { key: 'added_at', label: t('shipments.baskets.added'), format: 'datetime', sortable: true },
          { key: 'removed_at', label: t('shipments.baskets.removed'), format: 'datetime', sortable: true },
          { key: 'expires_at', label: t('shipments.baskets.expires'), format: 'datetime', sortable: true },
        ]}
        rows={rows}
        allowSelection={false}
        emptyText={t('shipments.baskets.noBasketAssignmentRecordedFor')}
        onRowClick={(row) => {
          const basketId = String(row.basket_id ?? '');
          if (basketId) setSelectedBasketId(basketId);
        }}
        getRowClass={(row) => (String(row.basket_id ?? '') === activeBasketId ? 'is-active' : undefined)}
        rowActions={[
          {
            label: t('shipments.baskets.inspectBasketRelationship'),
            icon: 'layers',
            onClick: (row) => {
              const basketId = String(row.basket_id ?? '');
              if (basketId) setSelectedBasketId(basketId);
            },
          },
        ]}
      />
      {relationshipRows.length ? (
        <div className="insight-card">
          <div className="insight-card__title">{t('shipments.baskets.basketRelationshipDetail')}</div>
          <KvGrid rows={relationshipRows} />
        </div>
      ) : null}
      <div className="insight-card">
        <div className="insight-card__title">{t('shipments.baskets.basketActivityForThisShipment')}</div>
        {transitions.length ? (
          <DataTable
            columns={[
              { key: 'basket_label', label: t('shipments.baskets.basket') },
              { key: 'previous_state', label: t('shipments.baskets.from'), lookup: 'basket_state' },
              { key: 'new_state', label: t('shipments.baskets.to'), lookup: 'basket_state' },
              { key: 'changed_at', label: t('shipments.baskets.changed'), format: 'datetime' },
              { key: 'actor_label', label: t('shipments.baskets.changedBy') },
              { key: 'notes', label: t('shipments.common.notes') },
            ]}
            rows={transitions}
            allowSelection={false}
            emptyText={t('shipments.baskets.noBasketStateTransitionsRecorded')}
          />
        ) : (
          <div className="state__hint">{t('shipments.baskets.noBasketStateTransitionsRecorded')}</div>
        )}
      </div>
    </div>
  );
}

export function RecipientTab({ shipment }: { shipment: Shipment }) {
  const t = useT();
  const recipientId = (shipment as { recipient_id?: string }).recipient_id;
  // Keep recipient edits inside the shipment drawer for operator flow, but write
  // to the customer SSOT through recipient_update_v1. Shipment modify only owns
  // shipment fields; recipient profile fields live on public.recipients.
  // W56-B-2 closure (F6) — recipient lookup migrated from `api.seed.recipients()`
  // to an id-scoped canonical registry read so the shipment drawer does not
  // load the global recipient table just to render one shipment.
  const updateRecipient = useRecipientUpdate();
  const canWrite = useCapability(CAP.RECIPIENTS_WRITE);
  const recipientsQuery = useResourceRowsByIds<Record<string, unknown>>(
    'recipients',
    recipientId ? [recipientId] : [],
    { enabled: Boolean(recipientId) },
  );
  const recipient = useMemo<Record<string, unknown> | null | undefined>(() => {
    if (!recipientId) return null;
    if (recipientsQuery.isLoading) return undefined;
    const rows = recipientsQuery.data?.rows ?? [];
    return rows.find((r) => r.id === recipientId) ?? null;
  }, [recipientsQuery.isLoading, recipientsQuery.data, recipientId]);
  if (recipientsQuery.isError) {
    return (
      <StateView
        kind="error"
        title={t('shipments.recipient.recipientUnavailable')}
        hint={(recipientsQuery.error as Error).message}
      />
    );
  }
  if (recipient === undefined) return <StateView kind="loading" />;
  if (!recipient) return <div className="state__hint">{t('shipments.recipient.noRecipientOnThisShipment')}</div>;
  const rows: KvRow[] = [
    { key: 'name', label: t('shipments.recipient.name'), value: recipient.name, editable: true },
    { key: 'phone_number', label: t('shipments.recipient.phone'), value: recipient.phone_number, mono: true, editable: true },
    { key: 'email', label: t('shipments.recipient.email'), value: recipient.email, mono: true, editable: true },
    { key: 'external_id', label: t('shipments.recipient.externalId'), value: recipient.external_id, mono: true, editable: true },
    { key: 'preferred_language', label: t('shipments.common.language'), value: recipient.preferred_language, editable: true },
    { key: 'preferred_comm_channel', label: t('shipments.common.channel'), value: recipient.preferred_comm_channel, editable: true },
    { key: 'quiet_hours_start', label: t('shipments.common.quietFrom'), value: recipient.quiet_hours_start, mono: true, editable: true },
    { key: 'quiet_hours_end', label: t('shipments.common.quietTo'), value: recipient.quiet_hours_end, mono: true, editable: true },
  ];
  return (
    <KvGrid
      rows={rows}
      onEdit={
        canWrite
          ? async (key, value) => {
              try {
                await updateRecipient.mutateAsync({
                  recipient_id: recipientId as string,
                  [key]: value === '—' ? null : value,
                  communication_preferences: {
                    source: 'console_v2.shipments_drawer.recipient_tab',
                    shipment_id: shipment.id,
                  },
                });
                pushToast(fill(t('shipments.recipient.recipientKeyUpdated'), { key: String(key) }), 'good');
              } catch {
                pushToast(t('shipments.recipient.recipientDetailsCouldNotBe'), 'danger');
              }
            }
          : undefined
      }
    />
  );
}

export function CodTab({ shipment }: { shipment: Shipment }) {
  const { t, fmtCurrency } = useI18n();
  // W13-5 — closes OPERATIONS D3 §3 (CodTab.onEdit orphan-toast). Wires COD
  // amount/currency edits through `shipment_amend_cancel_v1(op='modify')`.
  // `cod_method` and `expected_at_stop` are display-only (synthetic column,
  // not on `public.shipments` — gated read-only until canonical projection
  // lands).
  const amend = useShipmentAmendCancel();
  const canWrite = useCapability(CAP.SHIPMENTS_WRITE);
  const actionsQuery = useResourceList<ShipmentActionPaymentRow>('shipment_actions', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'timestamp', dir: 'desc' },
    page_size: 25,
  });
  const latestPayment = useMemo(
    () => latestCodPaymentProjection(actionsQuery.data?.rows),
    [actionsQuery.data?.rows],
  );
  if (!shipment.cod_amount) return <div className="state__hint">{t('shipments.cod.noCodOnThisShipment')}</div>;
  const paymentMethod = lookupDisplayValue(
    'payment_collection_method',
    latestPayment?.method ?? shipment.payment_collection_method ?? shipment.cod_method,
    t('shipments.cod.pendingCollectionProof'),
  );
  const collectionStatus = lookupDisplayValue(
    'payment_collection_outcome',
    latestPayment?.outcome ?? shipment.payment_collection_outcome ?? shipment.payment_collection_status,
    t('shipments.cod.pendingStopCloseout'),
  );
  const paymentCurrency = latestPayment?.currency ?? shipment.cod_currency;
  const collectedValue = latestPayment?.collectedAmount == null
    ? t('shipments.cod.pendingCloseout')
    : fmtCurrency(latestPayment.collectedAmount, paymentCurrency);
  const varianceValue = latestPayment?.varianceAmount == null
    ? t('shipments.cod.pendingCashierCount')
    : fmtCurrency(latestPayment.varianceAmount, paymentCurrency);
  const closeoutTime = latestPayment?.occurredAt
    ?? shipment.payment_collection_expected_at
    ?? t('shipments.cod.resolvedWhenTheDeliveryStop');
  const rows: KvRow[] = [
    { key: 'cod_amount', label: t('shipments.cod.amount'), value: fmtCurrency(shipment.cod_amount, shipment.cod_currency), mono: true, editable: true },
    { key: 'cod_currency', label: t('shipments.common.currency'), value: shipment.cod_currency, lookup: 'currency', editable: false },
    { key: 'cod_method', label: t('shipments.cod.collectionMethod'), value: paymentMethod, editable: false },
    { key: 'payment_collection_status', label: t('shipments.cod.collectionStatus'), value: collectionStatus, editable: false },
    { key: 'payment_collected_amount', label: t('shipments.cod.collected'), value: collectedValue, mono: latestPayment?.collectedAmount != null, editable: false },
    { key: 'payment_variance_amount', label: t('shipments.cod.variance'), value: varianceValue, mono: latestPayment?.varianceAmount != null, editable: false },
    { key: 'payment_closeout_at', label: t('shipments.cod.closeoutEvent'), value: closeoutTime, editable: false },
  ];
  return (
    <KvGrid
      rows={rows}
      onEdit={
        canWrite
          ? async (key, value) => {
              try {
                if (key !== 'cod_amount') {
                  throw new Error(`COD ${key} is read-only until an update workflow is available`);
                }
                await amend.mutateAsync({
                  shipmentId: shipment.id,
                  op: 'modify',
                  payload: {
                    changes: { [key]: value },
                    source: 'console.shipments_drawer.cod_tab',
                  },
                });
                pushToast(fill(t('shipments.cod.codKeyUpdated'), { key: String(key) }), 'good');
              } catch {
                pushToast(t('shipments.cod.codDetailsCouldNotBe'), 'danger');
              }
            }
          : undefined
      }
    />
  );
}

export function RouteTab({ shipment }: { shipment: Shipment }) {
  const t = useT();
  const go = useConsoleNavigator();
  // W13-5 — closes OPERATIONS D3 §4 (RouteTab.onEdit orphan-toast). Per the
  // deferred decision doc (`__audit__/DECISIONS/SHIPMENTS-DRAWER-CELL-EDITS.md`
  // §4), per-cell route edits are flipped to read-only here because the
  // canonical contract is the orchestrated DnD picker
  // (`ui_execute_route_stop_reassign_v1` / `ui_execute_route_run_assign_v1`),
  // which enforces conflict checks (`route_stop_reassign_events` audit,
  // `route_run_assignment_responses` ledger, `cod.float.max_per_driver`
  // policy). Wiring KvGrid.onEdit to a partial payload would skip these
  // gates, so the row-level affordance is removed and operators are forced
  // through the orchestrated picker on the dispatch surface.
  const stops = useResourceList<Record<string, unknown>>('route_stops', {
    filter: { shipment_id: shipment.id },
    page_size: 25,
  });
  const routeStopRows = stops.data?.rows ?? [];
  const shipmentStops = useMemo(
    () =>
      routeStopRows.filter((stop) => String(stop.shipment_id ?? '') === shipment.id),
    [routeStopRows, shipment.id],
  );
  const routeRunIds = useMemo(
    () =>
      Array.from(
        new Set(
          shipmentStops
            .map((stop) => (typeof stop.route_run_id === 'string' ? stop.route_run_id : ''))
            .filter(Boolean),
        ),
      ).sort(),
    [shipmentStops],
  );
  const runs = useResourceRowsByIds<Record<string, unknown>>('route_runs', routeRunIds, {
    enabled: routeRunIds.length > 0,
  });
  if (stops.isLoading || runs.isLoading) return <StateView kind="loading" />;
  if (stops.isError) {
    return (
      <StateView
        kind="error"
        title={t('shipments.route.routeStopsUnavailable')}
        hint={(stops.error as Error).message}
      />
    );
  }
  if (runs.isError) {
    return (
      <StateView
        kind="error"
        title={t('shipments.route.routeRunUnavailable')}
        hint={(runs.error as Error).message}
      />
    );
  }
  if (routeStopRows.length > 0 && shipmentStops.length !== routeStopRows.length) {
    return (
      <StateView
        kind="error"
        title={t('shipments.route.routeStopScopeMismatch')}
        hint={t('shipments.route.routeStopDetailsCouldNot')}
      />
    );
  }
  const stop = shipmentStops[0];
  if (!stop) return <div className="state__hint">{t('shipments.route.notYetOnARoute')}</div>;
  const routeRunId = typeof stop.route_run_id === 'string' ? stop.route_run_id : '';
  const run = (runs.data?.rows ?? []).find((rr) => rr.id === routeRunId);
  const rows: KvRow[] = [
    { key: 'run_id', label: t('shipments.route.run'), value: run?.run_id ?? '—', mono: true, editable: false },
    { key: 'driver', label: t('shipments.route.driver'), value: run?.driver ?? '—', editable: false },
    { key: 'vehicle', label: t('shipments.route.vehicle'), value: run?.vehicle ?? '—', mono: true, editable: false },
    { key: 'sequence_order', label: t('shipments.route.stop'), value: String(stop.sequence_order ?? ''), mono: true, editable: false },
    { key: 'window', label: t('shipments.route.window'), value: `${stop.window_start ?? ''}–${stop.window_end ?? ''}`, mono: true, editable: false },
    { key: 'sla_tone', label: t('shipments.route.sla'), value: stop.sla_tone, editable: false },
    { key: 'status', label: t('shipments.common.status'), value: stop.status, editable: false },
  ];
  return (
    <div>
      <div className="state__hint" style={{ padding: '6px 14px' }}>
        {t('shipments.route.routeAssignmentsAreReadOnly')}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 14px 10px' }}>
        <Button
          label={t('shipments.route.openDispatch')}
          iconName="truck"
          kind="ghost"
          capability={CAP.ROUTES_READ}
          onClick={() => go(`/operate/dispatch?route_stop=${encodeURIComponent(String(stop.id))}`)}
        />
      </div>
      <KvGrid rows={rows} />
    </div>
  );
}

export function TasksTab({ shipment }: { shipment: Shipment }) {
  const t = useT();
  const go = useConsoleNavigator();
  // W16-1 — closes OPERATIONS D3 §5/§6 (TasksTab cell-edit canonical wiring).
  // Aligns to the canonical `public.tasks` projection (`sla_due_at`, `id`,
  // `task_type_id` per migration 202601212300_tasks_ssot_core.sql:362-390).
  // The cell-edit handler now:
  //   1. Routes the only editable column (`status`) through the canonical
  //      `transition_task_v1(next_status)` seam.
  //   2. Reports failures via toast + returns `{ ok: false }` so the
  //      DataTable rolls back the optimistic edit instead of silently
  //      swallowing a rejection.
  //   3. Refuses unknown keys (defensive — non-status columns are
  //      `editable: false` so this branch should never fire today, but the
  //      guard keeps the seam fail-closed if a future column flips to
  //      editable without a paired RPC).
  // The `task_id` column key is the canonical seed projection alias for
  // `tasks.id` (see `__audit__/SCHEMA-DRIFT/OPERATIONS.md` §4); the seed
  // retains it for back-compat until G1 paired projection update lands.
  const tasks = useResourceList<Record<string, unknown>>('tasks', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'sla_due_at', dir: 'asc' },
    page_size: 100,
  });
  const transition = useTransitionTask();
  const canWriteTasks = useCapability(CAP.TASKS_WRITE);
  const canCompleteTasks = useCapability(CAP.TASKS_COMPLETE);
  const canTransitionTask = canEditShipmentTaskStatus(canWriteTasks, canCompleteTasks);
  if (tasks.isLoading) return <StateView kind="loading" />;
  if (tasks.isError) {
    return (
      <StateView
        kind="error"
        title={t('shipments.tasks.tasksUnavailable')}
        hint={(tasks.error as Error).message}
      />
    );
  }
  const rows = tasks.data?.rows ?? [];
  if (!rows.length) return <div className="state__hint">{t('shipments.tasks.noRelatedTasks')}</div>;
  return (
    <DataTable
      columns={[
        { key: 'task_id', label: t('shipments.tasks.task'), sortable: true, render: (raw) => compactReference(raw, t('shipments.tasks.task')) },
        { key: 'task_type', label: t('shipments.common.type'), lookup: 'task_type' },
        { key: 'status', label: t('shipments.common.status'), lookup: 'task_status', editable: canTransitionTask },
        { key: 'sla_due_at', label: t('shipments.tasks.slaDue'), format: 'datetime' },
      ]}
      rows={rows as Array<Record<string, unknown>>}
      allowSelection={false}
      onCellEdit={
        canTransitionTask
          ? async (row, key, value) => {
              if (key !== 'status') {
                return { ok: false, error: fill(t('shipments.tasks.fieldKeyIsReadOnly'), { key: String(key) }) };
              }
              const taskId = (row as { id?: string }).id;
              if (!taskId) {
                return { ok: false, error: t('shipments.tasks.taskIdMissing') };
              }
              try {
                await transition.mutateAsync({
                  taskId,
                  transition: { next_status: String(value) },
                });
                pushToast(fill(t('shipments.tasks.taskStatusUpdatedToValue'), { value: String(value) }), 'good');
                return { ok: true };
              } catch {
                pushToast(t('shipments.tasks.taskStatusCouldNotBe'), 'danger');
                return { ok: false, error: t('shipments.tasks.taskStatusCouldNotBe') };
              }
            }
          : undefined
      }
      rowActions={[
        {
          label: t('shipments.tasks.openTask'),
          icon: 'eye',
          onClick: (row) => {
            go(resolveShipmentTaskTarget(row as Record<string, unknown>));
          },
        },
      ]}
    />
  );
}

export function CommsTab({ shipment }: { shipment: Shipment }) {
  const t = useT();
  // CLAIM-OPERATIONS-WIRING (Phase C1) — replaces the 2-row inline literal
  // ('c1' / 'c2') with the canonical comms_attempts read seam. Production
  // swap: `ui_list_resource_v1('comms_attempts', { filter: { shipment_id }})`
  // against public.comms_attempts (Phase G migration).
  //
  // W13-5 — closes OPERATIONS D3 §3 (CommsTab "Send now" orphan-toast).
  // Wires the button through the canonical
  // `enqueue_comms_attempt_v1(shipment_id, channel)` seam (migration
  // 202604301600).
  //
  // W54-C closure — `channel` resolved strictly from canonical
  // `communication_policy.allowed_channels[0]` (NO inline `'sms'`
  // literal). Until a shipment-scoped recipient preference projection lands,
  // we use the first allowed channel from policy as the FE default.
  const { data, isLoading } = useResourceList<Record<string, unknown>>('comms_attempts', {
    filter: { shipment_id: shipment.id },
    sort: { key: 'occurred_at', dir: 'asc' },
  });
  const enqueue = useEnqueueCommsAttempt();
  const commsPolicy = useResolveSettings('communication_policy', undefined);
  const allowedChannels = (commsPolicy.data?.value as { allowed_channels?: string[] } | undefined)?.allowed_channels;
  const defaultChannel = allowedChannels?.[0] ?? null;
  if (isLoading) return <StateView kind="loading" />;
  const rows = data?.rows ?? [];
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '6px' }}>
        <Button
          label={t('shipments.comms.sendNow')}
          iconName="bell"
          kind="primary"
          capability={CAP.COMMS_WRITE}
          onClick={async () => {
            // W54-C — channel resolved from canonical
            // `communication_policy.allowed_channels[0]`. Missing canonical
            // row → loud error toast (NO silent fallback to inline 'sms').
            if (!defaultChannel) {
              pushToast(t('shipments.comms.noApprovedCommunicationChannelIs'), 'danger');
              return;
            }
            try {
              await enqueue.mutateAsync({
                shipment_id: shipment.id,
                channel: defaultChannel,
              });
              pushToast(t('shipments.comms.messageQueuedForDelivery'), 'good');
            } catch {
              pushToast(t('shipments.comms.messageCouldNotBeQueued'), 'danger');
            }
          }}
        />
      </div>
      <DataTable
        columns={[
          { key: 'occurred_at', label: t('shipments.common.when'), format: 'datetime' },
          { key: 'channel', label: t('shipments.common.channel') },
          { key: 'template', label: t('shipments.comms.template'), mono: true },
          { key: 'status', label: t('shipments.common.status') },
        ]}
        rows={rows}
        allowSelection={false}
        emptyText={t('shipments.comms.noCommsAttemptsRecorded')}
      />
    </div>
  );
}
