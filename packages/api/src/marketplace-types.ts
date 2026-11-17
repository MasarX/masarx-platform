export type MarketplaceContext = Record<string, unknown>;

export type MarketplaceRpcResult = Record<string, unknown>;

export type MarketplaceRequestKindCatalogEntry = {
  kind_key: string;
  label?: string | null;
  description?: string | null;
  participant_type_supply_key?: string | null;
  payload_schema?: unknown;
  ui_config?: Record<string, unknown> | null;
  default_materializer_key?: string | null;
  is_active?: boolean | null;
  is_public?: boolean | null;
  metadata?: Record<string, unknown> | null;
};

export type MarketplaceRequestKindCatalog = {
  request_kinds?: MarketplaceRequestKindCatalogEntry[] | null;
  marketplace_policy?: Record<string, unknown> | null;
  request_policy?: Record<string, unknown> | null;
  compliance_policy?: Record<string, unknown> | null;
  offer_schema?: unknown;
  contract_schema?: unknown;
  onboarding_schema?: unknown;
  verification_schema?: unknown;
};
