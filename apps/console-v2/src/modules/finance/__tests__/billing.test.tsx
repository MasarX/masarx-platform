// billing.test.tsx — covers BillingModule (CLAIM-FINANCE-BILLING, Wave 2).
//
// Asserts the load-bearing surface invariants:
//   • Mount + KPI strip + DataTable populated from canonical seed.
//   • Aging chip renders for invoices past due_date / status='overdue'.
//   • Capability gates on every supported write action (page-header +
//     drawer footer + row actions): billing.write / invoices.send /
//     invoices.refund.
//   • Drawer renders all 5 tabs (Lines / Backing usage events / Payment
//     timeline / Subscription source / Agreement terms) + TimelineLog tone
//     bullet matches the event_type contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { BillingModule, localDateInputValue } from '../billing';
import * as api from '@/lib/api';
import { getLookups } from '@/lib/data-source';
import {
  billing_invoice_events,
  billing_invoice_lines,
  billing_invoices,
  commercial_agreement_terms,
  commercial_agreements,
  subscriptions,
  usage_events,
} from '@/lib/seed-raw/finance-billing.js';
import { clients } from '@/lib/seed-raw/domain-shipments.js';

const realCompleteList = api.ui_list_resource_complete;
const TEST_NOW = new Date('2026-05-16T00:00:00Z');

function daysSince(date: string | null | undefined): number {
  if (!date) return 0;
  const then = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(then.getTime())) return 0;
  return Math.max(0, Math.floor((TEST_NOW.getTime() - then.getTime()) / 86_400_000));
}

function buildBillingDirectoryRows() {
  return billing_invoices.map((invoice) => {
    const lines = billing_invoice_lines.filter((line) => line.invoice_id === invoice.id);
    const events = billing_invoice_events
      .filter((event) => event.invoice_id === invoice.id)
      .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
    const lastEvent = events.at(-1);
    const refunded = events.find((event) => event.event_type === 'refunded');
    const voided = events.find((event) => event.event_type === 'voided');
    const amountDue = Number(invoice.amount_due ?? invoice.total_amount ?? 0);
    const issuedPastDue = invoice.status === 'issued' && amountDue > 0 && daysSince(invoice.due_date) > 0;

    return {
      invoice_id: invoice.id,
      organization_id: invoice.organization_id,
      client_id: invoice.client_id,
      client_label: invoice.client_label,
      sender_id: null,
      sender_label: null,
      line_count: lines.length,
      line_total_amount: lines.reduce((sum, line) => sum + Number(line.line_total ?? 0), 0),
      last_event_at: lastEvent?.occurred_at ?? null,
      last_event_type: lastEvent?.event_type ?? null,
      sent_at: invoice.sent_at,
      refunded_at: refunded?.occurred_at ?? null,
      voided_at: voided?.occurred_at ?? null,
      is_overdue: invoice.status === 'overdue' || issuedPastDue,
      payment_status: invoice.status,
      age_days: daysSince(invoice.due_date),
    };
  });
}

const billingResourceRows: Record<string, Array<Record<string, unknown>>> = {
  billing_invoices,
  billing_invoice_directory: buildBillingDirectoryRows(),
  billing_invoice_lines,
  billing_invoice_events,
  subscriptions,
  usage_events,
  commercial_agreements,
  commercial_agreement_terms,
  clients,
};

function listFromRows<T>(rows: Array<Record<string, unknown>>, opts?: api.ListOpts) {
  const filter = opts?.filter ?? {};
  const filteredRows = rows.filter((row) =>
    Object.entries(filter).every(([key, value]) => {
      if (value == null || value === '') return true;
      return row[key] === value;
    }),
  );
  return Promise.resolve({
    rows: filteredRows as T[],
    total: filteredRows.length,
    page: 0,
    page_size: filteredRows.length,
  });
}

async function waitForLookups(category: string) {
  const deadline = Date.now() + 1000;
  while (getLookups(category).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  await Promise.all([
    waitForLookups('invoice_status'),
    waitForLookups('billing_invoice_event_type'),
    waitForLookups('subscription_status'),
    waitForLookups('agreement_status'),
    waitForLookups('agreement_term_kind'),
    waitForLookups('usage_event_kind'),
    waitForLookups('client_status'),
  ]);

  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (resource, opts) => {
    const rows = billingResourceRows[resource];
    if (rows) return listFromRows(rows, opts);
    return realCompleteList(resource, opts);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState(null, '', '/');
});

// Helper: wait for the table to mount (signal that all queries have resolved).
async function waitForRows() {
  await waitFor(() => {
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });
}

function rowForInvoice(invoiceNumber: string): HTMLElement {
  const row = screen.getByText(invoiceNumber).closest('tr') as HTMLElement | null;
  expect(row).not.toBeNull();
  return row!;
}

function paletteItem(label: string): HTMLElement {
  const item = Array.from(document.querySelectorAll<HTMLElement>('.palette__item')).find(
    (node) => node.querySelector('.palette__item-label')?.textContent?.trim() === label,
  );
  expect(item).toBeTruthy();
  return item!;
}

describe('BillingModule (CLAIM-FINANCE-BILLING)', () => {
  it('resolves date-input defaults from the operator local day', () => {
    const utcLateNight = new Date('2026-05-17T21:30:00.000Z');
    const offsetForRiyadh = -180;

    expect(localDateInputValue(utcLateNight, offsetForRiyadh)).toBe('2026-05-18');
    expect(utcLateNight.toISOString().slice(0, 10)).toBe('2026-05-17');
  });

  it('mounts with KPI strip + invoice table populated from the canonical seed', async () => {
    const { container } = renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'clients.read', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    // KPI strip.
    const kpiStrip = container.querySelector('[data-testid="billing-kpi-strip"]') as HTMLElement | null;
    expect(kpiStrip).not.toBeNull();
    expect(within(kpiStrip!).getByText('Total outstanding')).toBeInTheDocument();
    expect(within(kpiStrip!).getByText('Overdue invoices')).toBeInTheDocument();
    expect(within(kpiStrip!).getByText('Paid this month')).toBeInTheDocument();
    expect(within(kpiStrip!).getByText('Drafts')).toBeInTheDocument();

    // Specific seed invoice numbers must be visible in the table.
    expect(screen.getByText('INV-2026-0301')).toBeInTheDocument();
    expect(screen.getByText('INV-2026-0303')).toBeInTheDocument();
    expect(screen.getByText('INV-2026-Q101')).toBeInTheDocument();
  });

  it('renders the aging chip on overdue rows (status=overdue or past due_date)', async () => {
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    // Two invoices are seeded as `status: overdue` (exampleoutlet March + EXAMPLESTORE Q1) —
    // both rows must surface an aging chip whose text starts with "overdue ".
    const chips = await screen.findAllByText(/^overdue \d+(d|h|m)$/);
    expect(chips.length).toBeGreaterThanOrEqual(2);
  });

  it('consumes the W25 billing_invoice_directory paired projection (overdue derives via projection.is_overdue)', async () => {
    // The two seeded `status: overdue` invoices must continue to render
    // the overdue chip when the projection is loaded; this asserts the
    // module actually consumes `billing_invoice_directory` rather than
    // only the legacy `isOverdueRow` fallback.
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    // The projection-derived row class for overdue is `is-risk` (rendered
    // via getRowClass). Two seeded overdue invoices means at least two
    // rows have the class.
    const rows = screen.getAllByRole('row');
    const dataRows = rows.slice(1);
    const overdueRows = dataRows.filter((r) =>
      (r as HTMLElement).className?.split(/\s+/).includes('is-risk'),
    );
    expect(overdueRows.length).toBeGreaterThanOrEqual(2);
  });

  it('calculates Total outstanding from backend amount_due instead of invoice total', async () => {
    const liveInvoices: Array<Record<string, unknown>> = [
      {
        ...billing_invoices[0],
        id: 'inv_partial_due_kpi',
        invoice_number: 'INV-PARTIAL-DUE-KPI',
        status: 'issued',
        total_amount: 1000,
        amount_paid: 750,
        amount_due: 250,
      },
    ];
    const liveDirectory = buildBillingDirectoryRows()
      .filter((row) => row.invoice_id === billing_invoices[0]?.id)
      .map((row) => ({
        ...row,
        invoice_id: 'inv_partial_due_kpi',
        payment_status: 'issued',
        is_overdue: false,
      }));

    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows([], opts);
      return realCompleteList(resource, opts);
    });

    const { container } = renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    const kpiStrip = container.querySelector('[data-testid="billing-kpi-strip"]') as HTMLElement | null;
    expect(kpiStrip).not.toBeNull();
    expect(within(kpiStrip!).getByText('250')).toBeInTheDocument();
    expect(within(kpiStrip!).queryByText('1,000')).not.toBeInTheDocument();
  });

  it('calculates Paid this month from backend amount_paid instead of refunded invoice totals', async () => {
    const liveInvoices: Array<Record<string, unknown>> = [
      {
        ...billing_invoices[0],
        id: 'inv_refunded_paid_kpi',
        invoice_number: 'INV-REFUNDED-PAID-KPI',
        status: 'refunded',
        total_amount: 1000,
        amount_paid: 0,
        amount_due: 0,
        paid_at: new Date().toISOString(),
      },
    ];
    const liveDirectory = buildBillingDirectoryRows()
      .filter((row) => row.invoice_id === billing_invoices[0]?.id)
      .map((row) => ({
        ...row,
        invoice_id: 'inv_refunded_paid_kpi',
        payment_status: 'refunded',
        is_overdue: false,
      }));

    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows([], opts);
      return realCompleteList(resource, opts);
    });

    const { container } = renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    const kpiStrip = container.querySelector('[data-testid="billing-kpi-strip"]') as HTMLElement | null;
    expect(kpiStrip).not.toBeNull();
    expect(kpiStrip!).toHaveTextContent(/Paid this month\s*0\s*0 paid/i);
    expect(within(kpiStrip!).queryByText('1,000')).not.toBeInTheDocument();
  });

  it('keeps zero-due issued invoices out of overdue operator queues', async () => {
    const liveInvoices: Array<Record<string, unknown>> = [
      {
        ...billing_invoices[0],
        id: 'inv_zero_due_issued',
        invoice_number: 'INV-ZERO-DUE-ISSUED',
        status: 'issued',
        total_amount: 0,
        amount_paid: 0,
        amount_due: 0,
        due_date: '2025-01-15',
      },
    ];
    const liveDirectory = buildBillingDirectoryRows()
      .filter((row) => row.invoice_id === billing_invoices[0]?.id)
      .map((row) => ({
        ...row,
        invoice_id: 'inv_zero_due_issued',
        payment_status: 'issued',
        is_overdue: true,
        age_days: 365,
      }));

    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows([], opts);
      return realCompleteList(resource, opts);
    });

    const { container } = renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    const kpiStrip = container.querySelector('[data-testid="billing-kpi-strip"]') as HTMLElement | null;
    expect(kpiStrip).not.toBeNull();
    expect(kpiStrip!).toHaveTextContent(/Overdue invoices\s*0\s*none past due/i);
    const invoiceRow = rowForInvoice('INV-ZERO-DUE-ISSUED');
    expect(invoiceRow).toHaveTextContent('Issued');
    expect(invoiceRow).not.toHaveTextContent(/overdue/i);
    expect(invoiceRow.className.split(/\s+/)).not.toContain('is-risk');
  });

  it('disables every write action when the user has only billing.read', async () => {
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read'],
    });
    await waitForRows();

    // Page-header "New invoice (draft)" is gated by `billing.write` — Button
    // appends a CapabilityLock chip suffix when the cap is missing, so the
    // accessible name contains the missing capability slug.
    const newBtn = await screen.findByRole('button', {
      name: /New invoice \(draft\).*Billing update permission required/i,
    });
    expect(newBtn).toBeDisabled();
  });

  it('enables write actions when the user holds the matching capabilities', async () => {
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const newBtn = await screen.findByRole('button', { name: 'New invoice (draft)' });
    expect(newBtn).toBeEnabled();
  });

  it('opens the drawer with the invoice number and all 5 tabs visible', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    // Click the first invoice row to open the drawer.
    await user.click(screen.getByText('INV-2026-0301'));

    // Drawer title contains "Invoice · INV-2026-0301".
    const titles = await screen.findAllByText(/Invoice · INV-2026-0301/);
    expect(titles.length).toBeGreaterThan(0);

    // 5 tabs in the drawer tablist.
    const tablist = await screen.findByRole('tablist', { name: /Invoice drawer tabs/i });
    expect(within(tablist).getByRole('tab', { name: /^Lines$/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Backing usage events/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Payment timeline/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Subscription source/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Agreement terms/i })).toBeInTheDocument();
  });

  it('Lines tab renders the line-item DataTable with seeded descriptions', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0301'));
    // Lines tab is the default; the lines-tab marker is present and
    // line descriptions appear.
    const linesTab = await screen.findByTestId('billing-drawer-lines-tab');
    expect(linesTab).toBeInTheDocument();
    expect(
      within(linesTab).getByText(/Express Kingdom · monthly subscription fee/),
    ).toBeInTheDocument();
  });

  it('Payment timeline tab renders TimelineLog with tone bullets per event_type', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0301'));

    const tablist = await screen.findByRole('tablist', { name: /Invoice drawer tabs/i });
    await user.click(within(tablist).getByRole('tab', { name: /Payment timeline/i }));

    const tlPanel = await screen.findByTestId('billing-drawer-timeline-tab');
    // Each TimelineLog row carries a `.primitive-tl__bullet--<tone>` class.
    // For inv_examplemarket_2026_03 we have drafted (neutral), sent (neutral), paid (good).
    // W49: bucket labels resolve asynchronously through `useResolveSettings`,
    // so wait for bullets to render once the canonical policy lands.
    await waitFor(() => {
      const bullets = tlPanel.querySelectorAll('.primitive-tl__bullet');
      expect(bullets.length).toBeGreaterThanOrEqual(3);
    });
    // At least one good-toned bullet (paid event).
    const goodBullets = tlPanel.querySelectorAll('.primitive-tl__bullet--good');
    expect(goodBullets.length).toBeGreaterThanOrEqual(1);
  });

  it('Subscription source tab renders the subscription KvGrid', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0301'));
    const tablist = await screen.findByRole('tablist', { name: /Invoice drawer tabs/i });
    await user.click(within(tablist).getByRole('tab', { name: /Subscription source/i }));
    const subTab = await screen.findByTestId('billing-drawer-subscription-tab');
    expect(within(subTab).getByText(/Express Kingdom · Monthly/i)).toBeInTheDocument();
  });

  it('Agreement terms tab renders the per-client agreement + term sheet', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0301'));
    const tablist = await screen.findByRole('tablist', { name: /Invoice drawer tabs/i });
    await user.click(within(tablist).getByRole('tab', { name: /Agreement terms/i }));
    const agTab = await screen.findByTestId('billing-drawer-agreement-tab');
    // Exampleparcel MSA is the matching agreement for cl_exampleparcel_ksa.
    expect(within(agTab).getByText(/Master Services Agreement · 2025–2027/)).toBeInTheDocument();
    // Term sheet contains the price_per_shipment row.
    expect(within(agTab).getByText('14 SAR (standard)')).toBeInTheDocument();
  });

  it('supported drawer footer write buttons are gated when capabilities are missing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, { capabilities: ['billing.read'] });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0301'));

    // "Send invoice" requires invoices.send.
    const sendBtn = await screen.findByRole('button', {
      name: /Send invoice.*Invoice send permission required/i,
    });
    expect(sendBtn).toBeDisabled();

    // "Record refund" requires invoices.refund.
    const refundBtn = screen.getByRole('button', {
      name: /Record refund.*Invoice refund permission required/i,
    });
    expect(refundBtn).toBeDisabled();

    // "Record payment" requires billing.write.
    const paymentBtn = screen.getByRole('button', {
      name: /Record payment.*Billing update permission required/i,
    });
    expect(paymentBtn).toBeDisabled();

    // "Void" requires billing.write because voiding is a draft invoice update,
    // not a refund lifecycle.
    const voidBtn = screen.getByRole('button', {
      name: /Void.*Billing update permission required/i,
    });
    expect(voidBtn).toBeDisabled();

    expect(screen.queryByRole('button', { name: /Mark paid/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Re-issue/i })).not.toBeInTheDocument();
  });

  it('keeps billing write actions inert when the user has read-only access', async () => {
    const createSpy = vi.spyOn(api, 'create_billing_invoice_v1');
    const updateSpy = vi.spyOn(api, 'update_billing_invoice_v1');
    const sendSpy = vi.spyOn(api, 'billing_invoice_send_v1');
    const bulkSendSpy = vi.spyOn(api, 'ui_bulk_billing_invoice_send_v1');
    const refundSpy = vi.spyOn(api, 'billing_invoice_refund_v1');
    const markPaidSpy = vi.spyOn(api, 'billing_invoice_mark_paid_v1');
    const voidSpy = vi.spyOn(api, 'void_billing_invoice_v1');
    const cancelSpy = vi.spyOn(api, 'cancel_subscription_v1');
    const user = userEvent.setup();

    renderWithProviders(<BillingModule />, { capabilities: ['billing.read'] });
    await waitForRows();

    const newBtn = await screen.findByRole('button', {
      name: /New invoice \(draft\).*Billing update permission required/i,
    });
    expect(newBtn).toBeDisabled();
    await user.click(newBtn);

    await user.click(screen.getAllByLabelText('Select row')[0]!);
    const bulkSend = await screen.findByRole('button', { name: /^Send$/ });
    expect(bulkSend).toBeDisabled();
    await user.click(bulkSend);

    await user.click(screen.getByText('INV-2026-0301'));
    const sendBtn = await screen.findByRole('button', {
      name: /Send invoice.*Invoice send permission required/i,
    });
    expect(sendBtn).toBeDisabled();
    await user.click(sendBtn);
    const refundBtn = await screen.findByRole('button', {
      name: /Record refund.*Invoice refund permission required/i,
    });
    expect(refundBtn).toBeDisabled();
    await user.click(refundBtn);
    const paymentBtn = await screen.findByRole('button', {
      name: /Record payment.*Billing update permission required/i,
    });
    expect(paymentBtn).toBeDisabled();
    await user.click(paymentBtn);
    const voidBtn = screen.getByRole('button', {
      name: /Void.*Billing update permission required/i,
    });
    expect(voidBtn).toBeDisabled();
    await user.click(voidBtn);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(bulkSendSpy).not.toHaveBeenCalled();
    expect(refundSpy).not.toHaveBeenCalled();
    expect(markPaidSpy).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
  });

  it('supported drawer footer write buttons are usable when the user holds the right capabilities', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0403'));
    // Send invoice is only exposed as an actionable draft-to-issued transition.
    const sendBtn = await screen.findByRole('button', { name: 'Send invoice' });
    expect(sendBtn).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Record payment' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Re-issue' })).not.toBeInTheDocument();
  });

  it('gates Void with billing.write instead of invoices.refund', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send'],
    });
    await waitForRows();

    await user.click(screen.getByText('INV-2026-0403'));
    const voidBtn = await screen.findByRole('button', { name: 'Void' });
    expect(voidBtn).toBeEnabled();

    const refundBtn = await screen.findByRole('button', {
      name: /Record refund.*Invoice refund permission required/i,
    });
    expect(refundBtn).toBeDisabled();
  });

  it('row action menu follows the same invoice lifecycle gates as the drawer footer', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    await user.click(within(rowForInvoice('INV-2026-0401')).getByLabelText('Row actions'));
    await waitFor(() => expect(document.querySelector('.palette__item')).toBeTruthy());

    expect(paletteItem('Open invoice')).not.toHaveClass('is-disabled');
    expect(paletteItem('Edit draft')).toHaveClass('is-disabled');
    expect(paletteItem('Send invoice')).toHaveClass('is-disabled');
    expect(paletteItem('Record payment')).not.toHaveClass('is-disabled');
    expect(paletteItem('Record refund')).toHaveClass('is-disabled');
    expect(paletteItem('Record refund')).toHaveTextContent(/no paid amount available to refund/i);
    expect(paletteItem('Void')).toHaveClass('is-disabled');
  });

  it('disables invoice lifecycle writes when the invoice belongs to a different tenant than the active operator scope', async () => {
    const updateSpy = vi.spyOn(api, 'update_billing_invoice_v1');
    const sendSpy = vi.spyOn(api, 'billing_invoice_send_v1');
    const markPaidSpy = vi.spyOn(api, 'billing_invoice_mark_paid_v1');
    const refundSpy = vi.spyOn(api, 'billing_invoice_refund_v1');
    const voidSpy = vi.spyOn(api, 'void_billing_invoice_v1');
    const crossTenantInvoices = billing_invoices.map((invoice) =>
      invoice.id === 'inv_examplemart_2026_04'
        ? { ...invoice, organization_id: 'org_other_tenant' }
        : invoice,
    );

    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(crossTenantInvoices, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    await user.click(within(rowForInvoice('INV-2026-0403')).getByLabelText('Row actions'));
    await waitFor(() => expect(document.querySelector('.palette__item')).toBeTruthy());

    expect(paletteItem('Open invoice')).not.toHaveClass('is-disabled');
    for (const label of ['Edit draft', 'Send invoice', 'Record payment', 'Record refund', 'Void']) {
      expect(paletteItem(label)).toHaveClass('is-disabled');
      expect(paletteItem(label)).toHaveTextContent(/Switch to this invoice's tenant before changing billing lifecycle/i);
      await user.click(paletteItem(label));
    }

    expect(updateSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
    expect(markPaidSpy).not.toHaveBeenCalled();
    expect(refundSpy).not.toHaveBeenCalled();
    expect(voidSpy).not.toHaveBeenCalled();
  });

  it('disables bulk Send when selected invoices include another tenant', async () => {
    const bulkSpy = vi.spyOn(api, 'ui_bulk_billing_invoice_send_v1');
    const crossTenantInvoices = billing_invoices.map((invoice) =>
      invoice.id === 'inv_examplemart_2026_04'
        ? { ...invoice, organization_id: 'org_other_tenant' }
        : invoice,
    );

    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(crossTenantInvoices, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    await user.click(within(rowForInvoice('INV-2026-0403')).getByLabelText('Select row'));
    const bulkSend = await screen.findByRole('button', { name: /^Send$/ });
    expect(bulkSend).toBeDisabled();
    expect(bulkSend).toHaveAttribute('title', "Switch to each selected invoice's tenant before sending.");
    await user.click(bulkSend);

    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it('enables Record refund for issued invoices only when backend paid amount is positive', async () => {
    const liveInvoices: Array<Record<string, unknown>> = billing_invoices.map((row) =>
      row.id === 'inv_examplemarket_2026_04'
        ? { ...row, amount_paid: 1500, amount_due: Number(row.total_amount) - 1500 }
        : { ...row },
    );
    const liveDirectory = buildBillingDirectoryRows().map((row) =>
      row.invoice_id === 'inv_examplemarket_2026_04'
        ? { ...row, payment_status: 'issued', is_overdue: false }
        : row,
    );

    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    await user.click(screen.getByText('INV-2026-0401'));
    const refundBtn = await screen.findByRole('button', { name: 'Record refund' });
    expect(refundBtn).toBeEnabled();
    await user.click(refundBtn);

    const dialog = await screen.findByRole('dialog', { name: /Record refund.*INV-2026-0401/i });
    expect(within(dialog).getByLabelText('Refund amount')).toHaveValue('1500');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// CLAIM-FINANCE-WIRING — Phase B5/C4 mutation contract tests
// ──────────────────────────────────────────────────────────────────────────

describe('BillingModule — Phase B5/C4 mutation wiring', () => {
  it('Send invoice fires billing_invoice_send_v1 with canonical payload + invalidates billing_invoices', async () => {
    const spy = vi.spyOn(api, 'billing_invoice_send_v1').mockResolvedValue({
      ok: true,
      billing_invoice_id: 'inv_test_1',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      version: 2,
      invoice_number: 'INV-2026-9999',
      issued_at: new Date().toISOString(),
    } as Awaited<ReturnType<typeof api.billing_invoice_send_v1>>);

    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const invSpy = vi.spyOn(queryClient, 'invalidateQueries');

    // Open the draft invoice so Send is enabled as the draft-to-issued action.
    await user.click(screen.getByText('INV-2026-0403'));
    const sendBtn = await screen.findByRole('button', { name: 'Send invoice' });
    await user.click(sendBtn);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('billing_invoice_id');
    expect(typeof payload.billing_invoice_id).toBe('string');
    await waitFor(() => {
      const calls = invSpy.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(calls.some((c) => c.includes('billing_invoices'))).toBe(true);
    });
  });

  it('Send invoice keeps the drawer open and shows backend issued readback without reload', async () => {
    window.history.pushState(null, '', '/finance/billing');
    let liveInvoices: Array<Record<string, unknown>> = billing_invoices.map((row) => ({ ...row }));
    let liveDirectory: Array<Record<string, unknown>> = buildBillingDirectoryRows().map((row) => ({ ...row }));
    let liveEvents: Array<Record<string, unknown>> = billing_invoice_events.map((row) => ({ ...row }));

    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      if (resource === 'billing_invoice_events') return listFromRows(liveEvents, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    vi.spyOn(api, 'billing_invoice_send_v1').mockImplementation(async (args) => {
      const issuedAt = '2026-05-17T09:40:00Z';
      liveInvoices = liveInvoices.map((invoice) =>
        invoice.id === args.billing_invoice_id
          ? { ...invoice, status: 'issued', effective_status: 'issued', sent_at: issuedAt }
          : invoice,
      );
      liveDirectory = liveDirectory.map((row) =>
        row.invoice_id === args.billing_invoice_id
          ? {
              ...row,
              payment_status: 'issued',
              sent_at: issuedAt,
              last_event_at: issuedAt,
              last_event_type: 'billing_invoice.issued',
              is_overdue: false,
            }
          : row,
      );
      liveEvents = [
        {
          id: 'bie_send_readback_1',
          invoice_id: args.billing_invoice_id,
          event_type: 'billing_invoice.issued',
          occurred_at: issuedAt,
          actor_user_id: 'usr_test_operator',
          payload: { source: 'billing_invoice_send_v1' },
        },
        ...liveEvents,
      ];
      return {
        ok: true,
        billing_invoice_id: String(args.billing_invoice_id),
        correlation_id: 'cor_send_readback',
        settings_resolution_id: 'srlv_send_readback',
        version: 2,
        invoice_number: 'INV-2026-0403',
        issued_at: issuedAt,
      } as Awaited<ReturnType<typeof api.billing_invoice_send_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const pathBefore = window.location.pathname;

    await user.click(screen.getByText('INV-2026-0403'));
    await user.click(await screen.findByRole('button', { name: 'Send invoice' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Invoice · INV-2026-0403' })).toBeInTheDocument();
      const invoiceRow = screen.getByText('INV-2026-0403').closest('tr');
      expect(invoiceRow).not.toBeNull();
      expect(invoiceRow as HTMLElement).toHaveTextContent('Issued');
      expect(screen.getAllByText('Issued').length).toBeGreaterThan(0);
    });
    const drawer = screen.getByRole('dialog', { name: /Invoice.*INV-2026-0403/i });
    expect(within(drawer).getByRole('button', { name: 'Edit draft' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Edit draft' })).toHaveAttribute(
      'title',
      'Only draft invoices can be edited.',
    );
    expect(within(drawer).getByRole('button', { name: 'Send invoice' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Send invoice' })).toHaveAttribute(
      'title',
      'This invoice status does not allow send.',
    );
    expect(within(drawer).getByRole('button', { name: 'Void' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Void' })).toHaveAttribute(
      'title',
      'Only draft invoices can be voided.',
    );
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'billing_invoice_directory').length,
    ).toBeGreaterThan(1);
  });

  it('bulk Send uses server-side ui_bulk_billing_invoice_send_v1 once for the selected invoices', async () => {
    const bulkSpy = vi.spyOn(api, 'ui_bulk_billing_invoice_send_v1').mockResolvedValue({
      ok: true,
      operation: 'billing_invoice_send',
      succeeded_count: 1,
      failed_count: 0,
      results: [],
    } as Awaited<ReturnType<typeof api.ui_bulk_billing_invoice_send_v1>>);
    const singleSpy = vi.spyOn(api, 'billing_invoice_send_v1');

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });

    await user.click(within(rowForInvoice('INV-2026-0403')).getByLabelText('Select row'));
    const bulkSend = await screen.findByRole('button', { name: /^Send$/ });
    await user.click(bulkSend);

    await waitFor(() => {
      expect(bulkSpy).toHaveBeenCalledTimes(1);
    });
    expect(singleSpy).not.toHaveBeenCalled();
    const payload = bulkSpy.mock.calls[0]![0]!;
    expect(payload.billing_invoice_ids).toHaveLength(1);
    expect(typeof payload.billing_invoice_ids[0]).toBe('string');
  });

  it('bulk Send disables mixed selections that include non-sendable invoice statuses', async () => {
    const bulkSpy = vi.spyOn(api, 'ui_bulk_billing_invoice_send_v1');
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    await user.click(within(rowForInvoice('INV-2026-0301')).getByLabelText('Select row'));
    await user.click(within(rowForInvoice('INV-2026-0403')).getByLabelText('Select row'));
    const bulkSend = await screen.findByRole('button', { name: /^Send$/ });

    expect(bulkSend).toBeDisabled();
    expect(bulkSend).toHaveAttribute(
      'title',
      'Selected invoices include a status that cannot be sent.',
    );
    await user.click(bulkSend);
    expect(bulkSpy).not.toHaveBeenCalled();
  });

  it('bulk Send refreshes selected invoice rows from backend readback without reload', async () => {
    window.history.pushState(null, '', '/finance/billing');
    let liveInvoices: Array<Record<string, unknown>> = billing_invoices.map((row) => ({ ...row }));
    let liveDirectory: Array<Record<string, unknown>> = buildBillingDirectoryRows().map((row) => ({ ...row }));
    let liveEvents: Array<Record<string, unknown>> = billing_invoice_events.map((row) => ({ ...row }));

    const draftInvoiceIds = ['inv_examplemart_2026_04', 'inv_examplemarket_2026_05_draft'];
    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      if (resource === 'billing_invoice_events') return listFromRows(liveEvents, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    const bulkSpy = vi.spyOn(api, 'ui_bulk_billing_invoice_send_v1').mockImplementation(async (args) => {
      const issuedAt = '2026-05-17T11:05:00Z';
      const ids = args.billing_invoice_ids;
      liveInvoices = liveInvoices.map((invoice) =>
        ids.includes(String(invoice.id))
          ? { ...invoice, status: 'issued', effective_status: 'issued', sent_at: issuedAt, issued_at: issuedAt }
          : invoice,
      );
      liveDirectory = liveDirectory.map((row) =>
        ids.includes(String(row.invoice_id))
          ? {
              ...row,
              payment_status: 'issued',
              sent_at: issuedAt,
              last_event_at: issuedAt,
              last_event_type: 'billing_invoice.issued',
              is_overdue: false,
            }
          : row,
      );
      liveEvents = [
        ...ids.map((id, index) => ({
          id: `bie_bulk_send_readback_${index + 1}`,
          invoice_id: id,
          event_type: 'billing_invoice.issued',
          occurred_at: issuedAt,
          actor_user_id: 'usr_test_operator',
          payload: { source: 'ui_bulk_billing_invoice_send_v1' },
        })),
        ...liveEvents,
      ];
      return {
        ok: true,
        operation: 'billing_invoice_send',
        succeeded_count: ids.length,
        failed_count: 0,
        results: ids.map((id) => ({
          ok: true,
          billing_invoice_id: id,
          result: { ok: true, billing_invoice_id: id, issued_at: issuedAt },
        })),
      } as Awaited<ReturnType<typeof api.ui_bulk_billing_invoice_send_v1>>;
    });
    const singleSpy = vi.spyOn(api, 'billing_invoice_send_v1');

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const pathBefore = window.location.pathname;

    for (const invoiceNo of ['INV-2026-0403', 'INV-2026-0501']) {
      const row = screen.getByText(invoiceNo).closest('tr');
      expect(row).not.toBeNull();
      await user.click(within(row as HTMLElement).getByLabelText('Select row'));
    }
    await user.click(await screen.findByRole('button', { name: /^Send$/ }));

    await waitFor(() => {
      expect(bulkSpy).toHaveBeenCalledTimes(1);
      for (const invoiceNo of ['INV-2026-0403', 'INV-2026-0501']) {
        const row = screen.getByText(invoiceNo).closest('tr');
        expect(row).not.toBeNull();
        expect(row as HTMLElement).toHaveTextContent('Issued');
      }
    });
    expect(singleSpy).not.toHaveBeenCalled();
    expect(bulkSpy.mock.calls[0]![0].billing_invoice_ids).toEqual(draftInvoiceIds);
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'billing_invoice_directory').length,
    ).toBeGreaterThan(1);
  });

  it('does not expose unsupported Mark paid or Re-issue workarounds', async () => {
    const updateSpy = vi.spyOn(api, 'update_billing_invoice_v1');
    const sendSpy = vi.spyOn(api, 'billing_invoice_send_v1');
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    await user.click(screen.getByText('INV-2026-0401'));

    expect(screen.queryByRole('button', { name: 'Mark paid' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-issue' })).not.toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('Edit draft submits update_billing_invoice_v1 for draft invoices', async () => {
    const liveInvoice = {
      id: 'inv_no_line_edit',
      invoice_number: 'INV-NO-LINE-EDIT',
      organization_id: 'org_rashed',
      client_id: 'cl_live_raw_backend',
      client_label: 'Live raw backend client',
      period_start: '2026-05-01',
      period_end: '2026-05-31',
      total_amount: 12500,
      total: 12500,
      amount_due: 12500,
      currency: 'SAR',
      status: 'draft',
      due_date: '2026-06-15',
      due_at: '2026-06-15T00:00:00Z',
      metadata: {},
    };
    const liveDirectory = {
      invoice_id: 'inv_no_line_edit',
      id: 'inv_no_line_edit',
      organization_id: 'org_rashed',
      client_id: 'cl_live_raw_backend',
      client_label: 'Live raw backend client',
      line_count: 0,
      line_total_amount: 0,
      last_event_at: null,
      last_event_type: null,
      sent_at: null,
      refunded_at: null,
      voided_at: null,
      is_overdue: false,
      payment_status: 'draft',
      age_days: 0,
    };
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows([liveInvoice], opts);
      if (resource === 'billing_invoice_directory') return listFromRows([liveDirectory], opts);
      if (resource === 'billing_invoice_lines') return listFromRows([], opts);
      if (resource === 'billing_invoice_events') return listFromRows([], opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });
    const updateSpy = vi.spyOn(api, 'update_billing_invoice_v1').mockResolvedValue({
      ok: true,
      billing_invoice_id: 'inv_no_line_edit',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      version: 4,
    } as Awaited<ReturnType<typeof api.update_billing_invoice_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-NO-LINE-EDIT'));
    await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
    const total = await screen.findByLabelText('Total');
    await user.clear(total);
    await user.type(total, '33300');
    await user.click(screen.getByRole('button', { name: 'Update draft' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({
      billing_invoice_id: 'inv_no_line_edit',
      total: 33300,
    });
  });

  it('Edit draft keeps line-backed invoice totals read-only and submits the backend line total', async () => {
    const liveInvoice = {
      id: 'inv_line_backed_edit',
      invoice_number: 'INV-LINE-BACKED-EDIT',
      organization_id: 'org_rashed',
      client_id: 'cl_live_raw_backend',
      client_label: 'Live raw backend client',
      period_start: '2026-05-01',
      period_end: '2026-05-31',
      total_amount: 345,
      total: 345,
      amount_due: 345,
      currency: 'SAR',
      status: 'draft',
      due_date: '2026-06-15',
      due_at: '2026-06-15T00:00:00Z',
      metadata: {},
    };
    const liveLine = {
      id: 'bil_line_backed_edit',
      invoice_id: 'inv_line_backed_edit',
      organization_id: 'org_rashed',
      description: 'Line-backed edit total',
      quantity: 1,
      unit_price: 115,
      amount: 115,
      currency: 'sar',
    };
    const liveDirectory = {
      invoice_id: 'inv_line_backed_edit',
      id: 'inv_line_backed_edit',
      organization_id: 'org_rashed',
      client_id: 'cl_live_raw_backend',
      client_label: 'Live raw backend client',
      line_count: 1,
      line_total_amount: 115,
      last_event_at: null,
      last_event_type: null,
      sent_at: null,
      refunded_at: null,
      voided_at: null,
      is_overdue: false,
      payment_status: 'draft',
      age_days: 0,
    };

    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows([liveInvoice], opts);
      if (resource === 'billing_invoice_directory') return listFromRows([liveDirectory], opts);
      if (resource === 'billing_invoice_lines') return listFromRows([liveLine], opts);
      if (resource === 'billing_invoice_events') return listFromRows([], opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });
    const updateSpy = vi.spyOn(api, 'update_billing_invoice_v1').mockResolvedValue({
      ok: true,
      billing_invoice_id: 'inv_line_backed_edit',
      correlation_id: 'cor_line_backed_edit',
      settings_resolution_id: 'srlv_line_backed_edit',
      version: 2,
      total: 115,
      amount_due: 115,
    } as Awaited<ReturnType<typeof api.update_billing_invoice_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-LINE-BACKED-EDIT'));
    await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit draft.*INV-LINE-BACKED-EDIT/i });
    const totalInput = within(dialog).getByLabelText('Total') as HTMLInputElement;
    expect(totalInput).toHaveValue('115');
    expect(totalInput).toHaveAttribute('readonly');

    await user.clear(within(dialog).getByLabelText('Due date'));
    await user.type(within(dialog).getByLabelText('Due date'), '2026-07-20');
    await user.click(within(dialog).getByRole('button', { name: 'Update draft' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledTimes(1);
    });
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({
      billing_invoice_id: 'inv_line_backed_edit',
      total: 115,
      due_at: '2026-07-20',
    });
  });

  it('Edit draft keeps the drawer open and shows backend updated readback without reload', async () => {
    window.history.pushState(null, '', '/finance/billing');
    let liveInvoices: Array<Record<string, unknown>> = billing_invoices.map((row) => ({ ...row }));
    let liveDirectory: Array<Record<string, unknown>> = buildBillingDirectoryRows().map((row) => ({ ...row }));
    let liveEvents: Array<Record<string, unknown>> = billing_invoice_events.map((row) => ({ ...row }));

    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      if (resource === 'billing_invoice_lines') return listFromRows([], opts);
      if (resource === 'billing_invoice_events') return listFromRows(liveEvents, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    vi.spyOn(api, 'update_billing_invoice_v1').mockImplementation(async (args) => {
      const updatedAt = '2026-05-17T10:45:00Z';
      const total = Number(args.total ?? 33300);
      liveInvoices = liveInvoices.map((invoice) =>
        invoice.id === args.billing_invoice_id
          ? {
              ...invoice,
              total_amount: total,
              total,
              amount_due: total,
              due_date: '2026-06-20',
              due_at: '2026-06-20T00:00:00Z',
              period_start: '2026-05-01',
              period_start_at: '2026-05-01T00:00:00Z',
              period_end: '2026-05-31',
              period_end_at: '2026-05-31T00:00:00Z',
            }
          : invoice,
      );
      liveDirectory = liveDirectory.map((row) =>
        row.invoice_id === args.billing_invoice_id
          ? {
              ...row,
              last_event_at: updatedAt,
              last_event_type: 'billing_invoice.updated',
              line_total_amount: total,
            }
          : row,
      );
      liveEvents = [
        {
          id: 'bie_update_readback_1',
          invoice_id: args.billing_invoice_id,
          event_type: 'billing_invoice.updated',
          occurred_at: updatedAt,
          actor_user_id: 'usr_test_operator',
          payload: { total, due_at: args.due_at },
        },
        ...liveEvents,
      ];
      return {
        ok: true,
        billing_invoice_id: String(args.billing_invoice_id),
        correlation_id: 'cor_update_readback',
        settings_resolution_id: 'srlv_update_readback',
        version: 4,
        total,
        amount_due: total,
      } as Awaited<ReturnType<typeof api.update_billing_invoice_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const pathBefore = window.location.pathname;

    await user.click(screen.getByText('INV-2026-0403'));
    await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
    const dialog = await screen.findByRole('dialog', { name: /Edit draft.*INV-2026-0403/i });
    await user.clear(within(dialog).getByLabelText('Total'));
    await user.type(within(dialog).getByLabelText('Total'), '33300');
    await user.clear(within(dialog).getByLabelText('Period start'));
    await user.type(within(dialog).getByLabelText('Period start'), '2026-05-01');
    await user.clear(within(dialog).getByLabelText('Period end'));
    await user.type(within(dialog).getByLabelText('Period end'), '2026-05-31');
    await user.clear(within(dialog).getByLabelText('Due date'));
    await user.type(within(dialog).getByLabelText('Due date'), '2026-06-20');
    await user.click(within(dialog).getByRole('button', { name: 'Update draft' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Edit draft/i })).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Invoice · INV-2026-0403' })).toBeInTheDocument();
      const invoiceRow = screen.getByText('INV-2026-0403').closest('tr');
      expect(invoiceRow).not.toBeNull();
      expect(invoiceRow as HTMLElement).toHaveTextContent('33,300');
      expect(invoiceRow as HTMLElement).toHaveTextContent('Jun 20');
    });
    const readbackDrawer = screen.getByRole('dialog', { name: 'Invoice · INV-2026-0403' });
    expect(within(readbackDrawer).getByText('2026-05-01 → 2026-05-31')).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'billing_invoice_directory').length,
    ).toBeGreaterThan(1);
  });

  it('Cancel subscription opens an in-app reason modal and fires cancel_subscription_v1', async () => {
    const spy = vi.spyOn(api, 'cancel_subscription_v1').mockResolvedValue({
      ok: true,
      subscription_id: 'sub_examplemart_monthly',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      version: 2,
      status: 'canceled',
      ends_at: '2026-05-17T10:00:00Z',
    } as Awaited<ReturnType<typeof api.cancel_subscription_v1>>);
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0403'));
    const tablist = await screen.findByRole('tablist', { name: /Invoice drawer tabs/i });
    await user.click(within(tablist).getByRole('tab', { name: /Subscription source/i }));
    await user.click(await screen.findByRole('button', { name: 'Cancel subscription' }));

    const dialog = await screen.findByRole('dialog', { name: /Cancel subscription.*sub_examplemart_monthly/i });
    const submit = within(dialog).getByRole('button', { name: 'Cancel subscription' });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Cancellation reason'), 'Contract ended by operator');
    await user.click(submit);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(promptSpy).not.toHaveBeenCalled();
    expect(spy.mock.calls[0]![0]).toMatchObject({
      subscription_id: 'sub_examplemart_monthly',
      cancellation_reason: 'Contract ended by operator',
    });
  });

  it('Cancel subscription keeps the drawer on the subscription tab and shows backend canceled readback without reload', async () => {
    window.history.pushState(null, '', '/finance/billing');
    let liveSubscriptions: Array<Record<string, unknown>> = subscriptions.map((row) => ({ ...row }));
    let liveSubscriptionEvents: Array<Record<string, unknown>> = [];

    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'subscriptions') return listFromRows(liveSubscriptions, opts);
      if (resource === 'subscription_events') return listFromRows(liveSubscriptionEvents, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    vi.spyOn(api, 'cancel_subscription_v1').mockImplementation(async (args) => {
      const endedAt = '2026-05-17T10:15:00Z';
      liveSubscriptions = liveSubscriptions.map((subscription) =>
        subscription.id === args.subscription_id
          ? {
              ...subscription,
              status: 'canceled',
              status_reason: args.cancellation_reason,
              ended_at: endedAt,
              ends_at: endedAt,
              version: 2,
            }
          : subscription,
      );
      liveSubscriptionEvents = [
        {
          id: 'sue_cancel_readback_1',
          subscription_id: args.subscription_id,
          organization_id: 'org_rashed',
          event_type: 'subscription.canceled',
          occurred_at: endedAt,
          actor_user_id: 'usr_test_operator',
          from_status: 'active',
          to_status: 'canceled',
          payload: { cancellation_reason: args.cancellation_reason },
          subscription_version: 2,
        },
        ...liveSubscriptionEvents,
      ];
      return {
        ok: true,
        subscription_id: String(args.subscription_id),
        correlation_id: 'cor_cancel_readback',
        settings_resolution_id: 'srlv_cancel_readback',
        version: 2,
        status: 'canceled',
        ends_at: endedAt,
      } as Awaited<ReturnType<typeof api.cancel_subscription_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const pathBefore = window.location.pathname;

    await user.click(screen.getByText('INV-2026-0403'));
    const tablist = await screen.findByRole('tablist', { name: /Invoice drawer tabs/i });
    await user.click(within(tablist).getByRole('tab', { name: /Subscription source/i }));
    await user.click(await screen.findByRole('button', { name: 'Cancel subscription' }));
    const dialog = await screen.findByRole('dialog', { name: /Cancel subscription.*sub_examplemart_monthly/i });
    await user.type(within(dialog).getByLabelText('Cancellation reason'), 'contract ended after review');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel subscription' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Cancel subscription/i })).not.toBeInTheDocument();
      const subscriptionTab = screen.getByTestId('billing-drawer-subscription-tab');
      expect(subscriptionTab).toHaveTextContent('sub_examplemart_monthly');
      expect(subscriptionTab).toHaveTextContent(/canceled/i);
      expect(subscriptionTab).toHaveTextContent('contract ended after review');
      expect(within(subscriptionTab).queryByRole('button', { name: 'Cancel subscription' })).not.toBeInTheDocument();
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'subscriptions').length,
    ).toBeGreaterThan(1);
  });

  it('Void opens an in-app reason modal and fires void_billing_invoice_v1', async () => {
    const spy = vi.spyOn(api, 'void_billing_invoice_v1').mockResolvedValue({
      ok: true,
      billing_invoice_id: 'inv_test_3',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      version: 3,
    } as Awaited<ReturnType<typeof api.void_billing_invoice_v1>>);
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    await user.click(screen.getByText('INV-2026-0403'));
    const voidBtn = await screen.findByRole('button', { name: 'Void' });
    await user.click(voidBtn);
    const dialog = await screen.findByRole('dialog', { name: /Void invoice.*INV-2026-0403/i });
    await user.type(within(dialog).getByLabelText('Void reason'), 'Customer churn');
    await user.click(within(dialog).getByRole('button', { name: 'Void invoice' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(promptSpy).not.toHaveBeenCalled();
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('billing_invoice_id');
    expect(payload.status_reason).toBe('Customer churn');
  });

  it('Void without a visible reason stays in the modal and does NOT fire RPC', async () => {
    const spy = vi.spyOn(api, 'void_billing_invoice_v1');
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0403'));
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    const dialog = await screen.findByRole('dialog', { name: /Void invoice.*INV-2026-0403/i });
    const submit = within(dialog).getByRole('button', { name: 'Void invoice' });

    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(spy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /Void invoice.*INV-2026-0403/i })).toBeInTheDocument();
  });

  it('Void keeps the operator on Billing and shows backend void readback without reload', async () => {
    window.history.pushState(null, '', '/finance/billing');
    let liveInvoices: Array<Record<string, unknown>> = billing_invoices.map((row) => ({ ...row }));
    let liveDirectory: Array<Record<string, unknown>> = buildBillingDirectoryRows().map((row) => ({ ...row }));
    let liveEvents: Array<Record<string, unknown>> = billing_invoice_events.map((row) => ({ ...row }));

    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      if (resource === 'billing_invoice_events') return listFromRows(liveEvents, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    vi.spyOn(api, 'void_billing_invoice_v1').mockImplementation(async (args) => {
      const voidedAt = '2026-05-17T08:10:00Z';
      liveInvoices = liveInvoices.map((invoice) =>
        invoice.id === args.billing_invoice_id
          ? { ...invoice, status: 'void', effective_status: 'void' }
          : invoice,
      );
      liveDirectory = liveDirectory.map((row) =>
        row.invoice_id === args.billing_invoice_id
          ? {
              ...row,
              payment_status: 'void',
              voided_at: voidedAt,
              last_event_at: voidedAt,
              last_event_type: 'billing_invoice.voided',
              is_overdue: false,
            }
          : row,
      );
      liveEvents = [
        {
          id: 'bie_void_readback_1',
          invoice_id: args.billing_invoice_id,
          event_type: 'billing_invoice.voided',
          created_at: voidedAt,
          actor_user_id: 'usr_test_operator',
          payload: { status_reason: args.status_reason },
        },
        ...liveEvents,
      ];
      return {
        ok: true,
        billing_invoice_id: String(args.billing_invoice_id),
        correlation_id: 'cor_void_readback',
        settings_resolution_id: 'srlv_void_readback',
        version: 2,
      } as Awaited<ReturnType<typeof api.void_billing_invoice_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const pathBefore = window.location.pathname;

    await user.click(screen.getByText('INV-2026-0403'));
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    const dialog = await screen.findByRole('dialog', { name: /Void invoice.*INV-2026-0403/i });
    await user.type(within(dialog).getByLabelText('Void reason'), 'duplicate draft');
    await user.click(within(dialog).getByRole('button', { name: 'Void invoice' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Void invoice/i })).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Invoice · INV-2026-0403' })).toBeInTheDocument();
      const timeline = screen.getByTestId('billing-drawer-timeline-tab');
      expect(timeline).toBeInTheDocument();
      expect(within(timeline).getByText('Voided')).toBeInTheDocument();
      expect(within(timeline).getByText('invoice.billing_invoice.voided')).toBeInTheDocument();
      const invoiceRow = screen.getByText('INV-2026-0403').closest('tr');
      expect(invoiceRow).not.toBeNull();
      expect(invoiceRow as HTMLElement).toHaveTextContent('Void');
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'billing_invoice_directory').length,
    ).toBeGreaterThan(1);
  });

  it('Record refund opens an in-app operator modal and fires billing_invoice_refund_v1', async () => {
    const spy = vi.spyOn(api, 'billing_invoice_refund_v1').mockResolvedValue({
      ok: true,
      billing_invoice_id: 'inv_test_4',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
      version: 3,
      refunded_amount: 100,
      status: 'paid',
    } as Awaited<ReturnType<typeof api.billing_invoice_refund_v1>>);
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    // Open a paid invoice (refund is enabled when status='paid').
    await user.click(screen.getByText('INV-2026-0301'));
    const refundBtn = await screen.findByRole('button', { name: 'Record refund' });
    await user.click(refundBtn);
    const dialog = await screen.findByRole('dialog', { name: /Record refund.*INV-2026-0301/i });
    await user.clear(within(dialog).getByLabelText('Refund amount'));
    await user.type(within(dialog).getByLabelText('Refund amount'), '100');
    await user.type(within(dialog).getByLabelText('Refund reason'), 'Goodwill credit');
    await user.click(within(dialog).getByRole('button', { name: 'Record refund' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(promptSpy).not.toHaveBeenCalled();
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('billing_invoice_id');
    expect(payload.refund_amount).toBe(100);
    expect(payload.refund_reason).toBe('Goodwill credit');
  });

  it('Refund with non-positive amount stays in the modal and does NOT fire RPC', async () => {
    const spy = vi.spyOn(api, 'billing_invoice_refund_v1');
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    await user.click(screen.getByText('INV-2026-0301'));
    const refundBtn = await screen.findByRole('button', { name: 'Record refund' });
    await user.click(refundBtn);
    const dialog = await screen.findByRole('dialog', { name: /Record refund.*INV-2026-0301/i });
    await user.clear(within(dialog).getByLabelText('Refund amount'));
    await user.type(within(dialog).getByLabelText('Refund amount'), '-5');
    const submit = within(dialog).getByRole('button', { name: 'Record refund' });

    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(spy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('Refund without a visible reason stays in the modal and does NOT fire RPC', async () => {
    const spy = vi.spyOn(api, 'billing_invoice_refund_v1');
    const promptSpy = vi.spyOn(window, 'prompt');

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    await user.click(screen.getByText('INV-2026-0301'));
    const refundBtn = await screen.findByRole('button', { name: 'Record refund' });
    await user.click(refundBtn);
    const dialog = await screen.findByRole('dialog', { name: /Record refund.*INV-2026-0301/i });
    await user.clear(within(dialog).getByLabelText('Refund amount'));
    await user.type(within(dialog).getByLabelText('Refund amount'), '100');
    const submit = within(dialog).getByRole('button', { name: 'Record refund' });

    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(spy).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('Refund keeps the operator on Billing and shows backend refunded readback without reload', async () => {
    window.history.pushState(null, '', '/finance/billing');
    let liveInvoices: Array<Record<string, unknown>> = billing_invoices.map((row) => (
      row.id === 'inv_examplemarket_2026_03'
        ? { ...row, amount_paid: 64280, amount_due: 0 }
        : { ...row }
    ));
    let liveDirectory: Array<Record<string, unknown>> = buildBillingDirectoryRows().map((row) => ({ ...row }));
    let liveEvents: Array<Record<string, unknown>> = billing_invoice_events.map((row) => ({ ...row }));

    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      if (resource === 'billing_invoice_events') return listFromRows(liveEvents, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    vi.spyOn(api, 'billing_invoice_refund_v1').mockImplementation(async (args) => {
      const refundedAt = '2026-05-17T09:25:00Z';
      liveInvoices = liveInvoices.map((invoice) =>
        invoice.id === args.billing_invoice_id
          ? {
              ...invoice,
              status: 'refunded',
              effective_status: 'refunded',
              amount_paid: 0,
              amount_due: 0,
            }
          : invoice,
      );
      liveDirectory = liveDirectory.map((row) =>
        row.invoice_id === args.billing_invoice_id
          ? {
              ...row,
              payment_status: 'refunded',
              refunded_at: refundedAt,
              last_event_at: refundedAt,
              last_event_type: 'billing_invoice.refunded',
              is_overdue: false,
            }
          : row,
      );
      liveEvents = [
        {
          id: 'bie_refund_readback_1',
          invoice_id: args.billing_invoice_id,
          event_type: 'billing_invoice.refunded',
          created_at: refundedAt,
          actor_user_id: 'usr_test_operator',
          payload: { refund_amount: args.refund_amount, refund_reason: args.refund_reason },
        },
        ...liveEvents,
      ];
      return {
        ok: true,
        billing_invoice_id: String(args.billing_invoice_id),
        correlation_id: 'cor_refund_readback',
        settings_resolution_id: 'srlv_refund_readback',
        version: 3,
        refunded_amount: Number(args.refund_amount),
        status: 'refunded',
      } as Awaited<ReturnType<typeof api.billing_invoice_refund_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const pathBefore = window.location.pathname;

    await user.click(screen.getByText('INV-2026-0301'));
    await user.click(await screen.findByRole('button', { name: 'Record refund' }));
    const dialog = await screen.findByRole('dialog', { name: /Record refund.*INV-2026-0301/i });
    await user.clear(within(dialog).getByLabelText('Refund amount'));
    await user.type(within(dialog).getByLabelText('Refund amount'), '64280');
    await user.type(within(dialog).getByLabelText('Refund reason'), 'customer credit memo');
    await user.click(within(dialog).getByRole('button', { name: 'Record refund' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Record refund/i })).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Invoice · INV-2026-0301' })).toBeInTheDocument();
      const timeline = screen.getByTestId('billing-drawer-timeline-tab');
      expect(timeline).toBeInTheDocument();
      expect(within(timeline).getByText('Refunded')).toBeInTheDocument();
      expect(within(timeline).getByText('invoice.billing_invoice.refunded')).toBeInTheDocument();
      const invoiceRow = screen.getByText('INV-2026-0301').closest('tr');
      expect(invoiceRow).not.toBeNull();
      expect(invoiceRow as HTMLElement).toHaveTextContent('Refunded');
    });
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'billing_invoice_directory').length,
    ).toBeGreaterThan(1);
  });

  it('Record payment keeps the operator on Billing and shows backend paid readback without reload', async () => {
    window.history.pushState(null, '', '/finance/billing');
    let liveInvoices: Array<Record<string, unknown>> = billing_invoices.map((row) => (
      row.id === 'inv_examplemarket_2026_04'
        ? { ...row, amount_paid: 0, amount_due: 71640 }
        : { ...row }
    ));
    let liveDirectory: Array<Record<string, unknown>> = buildBillingDirectoryRows().map((row) =>
      row.invoice_id === 'inv_examplemarket_2026_04'
        ? { ...row, amount_due: 71640, payment_status: 'issued', is_overdue: true }
        : { ...row },
    );
    let liveEvents: Array<Record<string, unknown>> = billing_invoice_events.map((row) => ({ ...row }));

    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      if (resource === 'billing_invoice_events') return listFromRows(liveEvents, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    vi.spyOn(api, 'billing_invoice_mark_paid_v1').mockImplementation(async (args) => {
      const paidAt = '2026-05-17T10:10:00Z';
      liveInvoices = liveInvoices.map((invoice) =>
        invoice.id === args.billing_invoice_id
          ? {
              ...invoice,
              status: 'paid',
              effective_status: 'paid',
              amount_paid: Number(args.payment_amount),
              amount_due: 0,
              paid_at: paidAt,
            }
          : invoice,
      );
      liveDirectory = liveDirectory.map((row) =>
        row.invoice_id === args.billing_invoice_id
          ? {
              ...row,
              payment_status: 'paid',
              paid_at: paidAt,
              amount_paid: Number(args.payment_amount),
              amount_due: 0,
              last_event_at: paidAt,
              last_event_type: 'billing_invoice.paid',
              is_overdue: false,
            }
          : row,
      );
      liveEvents = [
        {
          id: 'bie_mark_paid_readback_1',
          invoice_id: args.billing_invoice_id,
          event_type: 'billing_invoice.paid',
          created_at: paidAt,
          actor_user_id: 'usr_test_operator',
          payload: { payment_amount: args.payment_amount, payment_reference: args.payment_reference },
        },
        ...liveEvents,
      ];
      return {
        ok: true,
        billing_invoice_id: String(args.billing_invoice_id),
        correlation_id: 'cor_mark_paid_readback',
        settings_resolution_id: 'srlv_mark_paid_readback',
        version: 3,
        paid_amount: Number(args.payment_amount),
        status: 'paid',
        paid_at: paidAt,
      } as Awaited<ReturnType<typeof api.billing_invoice_mark_paid_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const pathBefore = window.location.pathname;

    await user.click(screen.getByText('INV-2026-0401'));
    await user.click(await screen.findByRole('button', { name: 'Record payment' }));
    const dialog = await screen.findByRole('dialog', { name: /Record payment.*INV-2026-0401/i });
    expect((within(dialog).getByLabelText('Payment amount') as HTMLInputElement).value).toContain('71,640');
    await user.type(within(dialog).getByLabelText('Payment reference'), 'bank receipt 20260524');
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Record payment/i })).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Invoice · INV-2026-0401' })).toBeInTheDocument();
      const timeline = screen.getByTestId('billing-drawer-timeline-tab');
      expect(timeline).toBeInTheDocument();
      expect(within(timeline).getByText('Paid')).toBeInTheDocument();
      expect(within(timeline).getByText('invoice.billing_invoice.paid')).toBeInTheDocument();
      const invoiceRow = screen.getByText('INV-2026-0401').closest('tr');
      expect(invoiceRow).not.toBeNull();
      expect(invoiceRow as HTMLElement).toHaveTextContent('Paid');
    });
    await user.click(within(screen.getByTestId('billing-drawer-timeline-tab')).getByText('invoice.billing_invoice.paid'));
    expect(await screen.findByText('bank receipt 20260524')).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'billing_invoice_directory').length,
    ).toBeGreaterThan(1);
  });

  it('renders live backend billing columns through the operator invoice view', async () => {
    const liveInvoice = {
      id: 'inv_live_raw_backend',
      organization_id: 'org_masarx',
      client_id: 'cl_live_raw_backend',
      client_label: 'Live raw backend client',
      invoice_number: 'INV-LIVE-RAW-001',
      status: 'paid',
      currency: 'sar',
      total: 115,
      amount_paid: 115,
      amount_due: 0,
      period_start_at: '2026-05-01T00:00:00Z',
      period_end_at: '2026-05-31T00:00:00Z',
      due_at: '2026-06-15T00:00:00Z',
      issued_at: '2026-06-01T09:00:00Z',
      paid_at: '2026-06-02T09:00:00Z',
      metadata: {},
    };
    const liveLine = {
      id: 'bil_live_raw_backend',
      invoice_id: 'inv_live_raw_backend',
      organization_id: 'org_masarx',
      description: 'Live backend line',
      quantity: 1,
      unit_price: 115,
      amount: 115,
      currency: 'sar',
    };
    const liveDirectory = {
      invoice_id: 'inv_live_raw_backend',
      id: 'inv_live_raw_backend',
      organization_id: 'org_masarx',
      client_id: 'cl_live_raw_backend',
      client_label: 'Live raw backend client',
      line_count: 1,
      line_total_amount: 115,
      last_event_at: '2026-06-02T09:00:00Z',
      last_event_type: 'billing_invoice.paid',
      sent_at: '2026-06-01T09:00:00Z',
      refunded_at: null,
      voided_at: null,
      is_overdue: false,
      payment_status: 'paid',
      age_days: 0,
    };

    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows([liveInvoice], opts);
      if (resource === 'billing_invoice_directory') return listFromRows([liveDirectory], opts);
      if (resource === 'billing_invoice_lines') return listFromRows([liveLine], opts);
      if (resource === 'billing_invoice_events') return listFromRows([], opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();

    const invoiceRow = screen.getByText('INV-LIVE-RAW-001').closest('tr');
    expect(invoiceRow).not.toBeNull();
    expect(invoiceRow as HTMLElement).toHaveTextContent('2026-05-01');
    expect(invoiceRow as HTMLElement).toHaveTextContent('2026-05-31');
    expect(invoiceRow as HTMLElement).toHaveTextContent('SAR 115');

    await user.click(screen.getByText('INV-LIVE-RAW-001'));
    const drawer = await screen.findByRole('heading', { name: 'Invoice · INV-LIVE-RAW-001' });
    expect(drawer).toBeInTheDocument();
    expect(screen.getByText('Live backend line')).toBeInTheDocument();
    expect(screen.getAllByText('SAR 115').length).toBeGreaterThan(0);
  });

  it('Create draft modal fires create_billing_invoice_v1 with canonical payload', async () => {
    const spy = vi.spyOn(api, 'create_billing_invoice_v1').mockResolvedValue({
      ok: true,
      billing_invoice_id: 'inv_test_5',
      invoice_number: 'INV-20260517-000001',
      correlation_id: 'cor_test',
      settings_resolution_id: 'srlv_test',
    } as Awaited<ReturnType<typeof api.create_billing_invoice_v1>>);

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'clients.read', 'invoices.send', 'invoices.refund'],
    });
    await waitFor(() => {
      expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    });
    const newBtn = await screen.findByRole('button', { name: 'New invoice (draft)' });
    await user.click(newBtn);
    // Modal opens with a canonical clients-resource select instead of a
    // free-text client id field.
    const clientSelect = await screen.findByLabelText('Client');
    expect(clientSelect.tagName.toLowerCase()).toBe('select');
    await waitFor(() => {
      expect((clientSelect as HTMLSelectElement).value).toBeTruthy();
    });
    const createBtn = await screen.findByRole('button', { name: 'Create draft' });
    await user.click(createBtn);

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const payload = spy.mock.calls[0]![0]!;
    expect(payload).toHaveProperty('client_id');
    expect(payload).toHaveProperty('currency');
    expect(payload).toMatchObject({ organization_id: 'org_rashed' });
    expect(typeof payload.client_id).toBe('string');
    expect(typeof payload.currency).toBe('string');
  });

  it('Create draft client picker excludes inactive or suspended clients', async () => {
    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    vi.mocked(api.ui_list_resource_complete).mockImplementation(async (resource, opts) => {
      if (resource === 'clients') {
        return listFromRows(
          [
            {
              id: 'cl_inactive_browser_proof',
              organization_id: 'org_rashed',
              name: 'Inactive Browser Proof Client',
              status: 'suspended',
            },
            {
              id: 'cl_cross_tenant_browser_proof',
              organization_id: 'org_other',
              name: 'Cross Tenant Browser Proof Client',
              status: 'active',
            },
            {
              id: 'cl_active_browser_proof',
              organization_id: 'org_rashed',
              name: 'Active Browser Proof Client',
              status: 'active',
            },
          ],
          opts,
        );
      }
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'clients.read', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    await user.click(await screen.findByRole('button', { name: 'New invoice (draft)' }));

    const clientSelect = await screen.findByLabelText('Client');
    await waitFor(() => {
      expect((clientSelect as HTMLSelectElement).value).toBe('cl_active_browser_proof');
    });
    await waitFor(() => {
      expect(completeSpy).toHaveBeenCalledWith(
        'clients',
        expect.objectContaining({
          filter: expect.objectContaining({ organization_id: 'org_rashed' }),
        }),
      );
    });
    expect(screen.getByText(/Active Browser Proof Client/i)).toBeInTheDocument();
    expect(screen.queryByText(/Inactive Browser Proof Client/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cross Tenant Browser Proof Client/i)).not.toBeInTheDocument();
  });

  it('human-click create draft flow reads the new invoice into the table and drawer without reload', async () => {
    let liveInvoices: Array<Record<string, unknown>> = billing_invoices.map((row) => ({ ...row }));
    let liveDirectory: Array<Record<string, unknown>> = buildBillingDirectoryRows().map((row) => ({ ...row }));
    const liveLines: Array<Record<string, unknown>> = billing_invoice_lines.map((row) => ({ ...row }));
    let liveEvents: Array<Record<string, unknown>> = billing_invoice_events.map((row) => ({ ...row }));

    const completeSpy = vi.mocked(api.ui_list_resource_complete);
    completeSpy.mockImplementation(async (resource, opts) => {
      if (resource === 'billing_invoices') return listFromRows(liveInvoices, opts);
      if (resource === 'billing_invoice_directory') return listFromRows(liveDirectory, opts);
      if (resource === 'billing_invoice_lines') return listFromRows(liveLines, opts);
      if (resource === 'billing_invoice_events') return listFromRows(liveEvents, opts);
      const rows = billingResourceRows[resource];
      if (rows) return listFromRows(rows, opts);
      return realCompleteList(resource, opts);
    });
    completeSpy.mockClear();

    const createSpy = vi.spyOn(api, 'create_billing_invoice_v1').mockImplementation(async (args) => {
      const createdAt = '2026-05-16T10:00:00Z';
      const invoice = {
        id: 'inv_live_click_2026_05',
        organization_id: args.organization_id,
        client_id: args.client_id,
        client_label: 'Backend readback client',
        period_start: null,
        period_end: null,
        total_amount: 0,
        currency: args.currency,
        status: 'draft',
        due_date: args.due_at ?? '2026-05-16',
        sent_at: null,
        paid_at: null,
        invoice_number: 'INV-2026-LIVE-CLICK',
        subscription_id: null,
        metadata: { source: 'human_click_readback_test' },
      };
      const directoryRow = {
        invoice_id: invoice.id,
        organization_id: invoice.organization_id,
        client_id: invoice.client_id,
        client_label: invoice.client_label,
        sender_id: null,
        sender_label: null,
        line_count: 0,
        line_total_amount: 0,
        last_event_at: createdAt,
        last_event_type: 'drafted',
        sent_at: null,
        refunded_at: null,
        voided_at: null,
        is_overdue: false,
        payment_status: 'draft',
        age_days: 0,
      };
      liveInvoices = [invoice, ...liveInvoices];
      liveDirectory = [directoryRow, ...liveDirectory];
      liveEvents = [
        {
          id: 'iev_live_click_2026_05',
          invoice_id: invoice.id,
          event_type: 'drafted',
          occurred_at: createdAt,
          actor_user_id: 'usr_test_operator',
          payload: { source: 'create_billing_invoice_v1' },
        },
        ...liveEvents,
      ];
      return {
        ok: true,
        id: invoice.id,
        invoice_number: invoice.invoice_number,
        correlation_id: 'cor_live_click',
        settings_resolution_id: 'srlv_live_click',
      } as unknown as Awaited<ReturnType<typeof api.create_billing_invoice_v1>>;
    });

    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, {
      capabilities: ['billing.read', 'billing.write', 'clients.read', 'invoices.send', 'invoices.refund'],
    });
    await waitForRows();
    const pathBefore = window.location.pathname;

    await user.click(await screen.findByRole('button', { name: 'New invoice (draft)' }));
    const clientSelect = await screen.findByLabelText('Client');
    await waitFor(() => {
      expect((clientSelect as HTMLSelectElement).value).toBeTruthy();
    });
    await user.click(await screen.findByRole('button', { name: 'Create draft' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({ organization_id: 'org_rashed' });
    await waitFor(() => {
      expect(screen.getByText('INV-2026-LIVE-CLICK')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument();
    const drawer = await screen.findByRole('dialog', { name: /Invoice.*INV-2026-LIVE-CLICK/i });
    expect(within(drawer).getByRole('button', { name: 'Edit draft' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Send invoice' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Void' })).toBeInTheDocument();
    const tablist = within(drawer).getByRole('tablist', { name: /Invoice drawer tabs/i });
    expect(within(tablist).getByRole('tab', { name: /^Lines$/i })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: /Payment timeline/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe(pathBefore);
    expect(
      completeSpy.mock.calls.filter(([resource]) => resource === 'billing_invoice_directory').length,
    ).toBeGreaterThan(1);
  });

});
