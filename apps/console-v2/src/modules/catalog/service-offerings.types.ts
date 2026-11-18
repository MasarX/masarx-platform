import type { ChipKind } from '@/components/Chip';

export interface ServiceLevelMetadata {
  tier?: string;
  priority_rank?: number;
  sla_minutes?: number;
  sla_label?: string;
  color_token?: string;
  tone?: ChipKind;
}

export interface ServiceLevelRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description?: string;
  is_active: boolean;
  metadata?: ServiceLevelMetadata;
  sla_label?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PricingBreakpoint {
  up_to_kg: number;
  price: number;
}

export interface ServiceOfferingMetadata {
  display?: { name: string; slug: string; status: string };
  base_price?: number;
  currency?: string;
  max_weight_kg?: number;
  included_features?: string[];
  pricing_breakpoints?: PricingBreakpoint[];
  coverage_summary?: string;
  active_subscriptions_count?: number;
  retired_reason?: string;
}

export interface ServiceOfferingRow extends Record<string, unknown> {
  id: string;
  service_level_id: string;
  branch_id: string;
  zone_id?: string | null;
  effective_from: string;
  effective_to?: string | null;
  priority: number;
  is_active: boolean;
  metadata?: ServiceOfferingMetadata;
  created_at?: string;
  updated_at?: string;
}

export interface BranchRow extends Record<string, unknown> {
  id: string;
  name: string;
  city?: string;
  type?: string;
}

export interface ZoneRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug?: string;
}

export interface ProductContextSetupReadback {
  level: ServiceLevelRow;
  branch: BranchRow;
  zone: ZoneRow | null;
  offering: ServiceOfferingRow;
}
