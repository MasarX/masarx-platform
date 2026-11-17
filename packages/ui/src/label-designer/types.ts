export type SearchParams = Record<string, string | string[] | undefined>;

export type ScopeType = "tenant" | "client" | "sender";

export type ScopeOption = {
  key: string;
  scopeType: ScopeType;
  scopeId: string;
  label: string;
};

export type DraftRow = {
  id: string;
  scope_type: ScopeType;
  scope_id: string;
  label_type: string;
  draft_name: string | null;
  draft_value: Record<string, unknown>;
  status: string;
  updated_at: string | null;
  published_at: string | null;
};

export type ShipmentOption = {
  id: string;
  label: string;
};

export type ShipmentBoxOption = {
  id: string;
  label: string;
};

export type AssetItem = {
  name: string;
  path: string;
};

export type LabelDesignerPageProps = {
  appBasePath: string;
  searchParams?: SearchParams;
  testIdPrefix?: string | null;
};
