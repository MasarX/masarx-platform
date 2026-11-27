// billing.arabic.test.tsx: the billing page renders its own copy in Arabic; invoice numbers, amounts and lookup labels stay as data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { BillingModule } from './billing';
import * as api from '@/lib/api';
import { getLookups } from '@/lib/data-source';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/finance';
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

describe('BillingModule in Arabic', () => {
  it('renders the page header, KPI strip and table headers in Arabic', async () => {
    renderWithProviders(<BillingModule />, { locale: 'ar', capabilities: ['all'] });
    await waitForRows();
    expect(screen.getByText(ar.billing.kpi.totalOutstanding)).toBeInTheDocument();
    const chrome = [
      ...document.querySelectorAll('.page-header__title-block, .page-header__pills .chip, .page-header__actions, .kpi__label, .kpi__delta, thead'),
    ];
    expect(chrome.length).toBeGreaterThan(0);
    expect(chrome.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('renders the invoice drawer tabs and summary labels in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BillingModule />, { locale: 'ar', capabilities: ['all'] });
    await waitForRows();
    await user.click(screen.getByText('INV-2026-0301'));
    const tablist = await screen.findByRole('tablist', { name: ar.billing.tabs.ariaLabel });
    const tabs = within(tablist).getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual([
      ar.billing.tabs.lines,
      ar.billing.tabs.usage,
      ar.billing.tabs.timeline,
      ar.billing.tabs.subscription,
      ar.billing.tabs.agreement,
    ]);
    expect(findUntranslated(tablist)).toEqual([]);
    const eyebrows = [...document.querySelectorAll('.eyebrow')];
    expect(eyebrows.length).toBeGreaterThan(0);
    expect(eyebrows.flatMap((element) => findUntranslated(element))).toEqual([]);
  });

  it('keeps the English copy that English callers and tests rely on', () => {
    expect(englishT('billing.kpi.totalOutstanding')).toBe('Total outstanding');
    expect(englishT('billing.reasons.onlyDraftEdit')).toBe('Only draft invoices can be edited.');
    expect(englishT('billing.drawer.title')).toBe('Invoice · {number}');
    expect(ar.billing.kpi.totalOutstanding).toBe('إجمالي المستحق');
    expect(ar.billing.actions.newInvoice).toBe('فاتورة جديدة (مسودة)');
  });
});
