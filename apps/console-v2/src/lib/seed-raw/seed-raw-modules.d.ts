type SeedRawRow = Record<string, any>;

declare module '@/lib/seed-raw/finance-billing.js' {
  export const billing_invoice_events: SeedRawRow[];
  export const billing_invoice_lines: SeedRawRow[];
  export const billing_invoices: SeedRawRow[];
  export const commercial_agreement_terms: SeedRawRow[];
  export const commercial_agreements: SeedRawRow[];
  export const subscriptions: SeedRawRow[];
  export const usage_events: SeedRawRow[];
}

declare module '@/lib/seed-raw/domain-shipments.js' {
  export const clients: SeedRawRow[];
}
