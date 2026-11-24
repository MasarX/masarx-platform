export interface LabelSpec extends Record<string, unknown> {
  id: string;                          // SSOT: label_template_specs.id
  name?: string;                       // Legacy alias for label_template_specs.template_key
  template_key?: string;               // SSOT: label_template_specs.template_key (canonical)
  version?: number;                    // SSOT: label_template_specs.version
  organization_id?: string;            // SSOT: label_template_specs.organization_id
  template_scope_type?: string;        // SSOT: label_template_specs.template_scope_type
  template_scope_id?: string | null;   // SSOT: label_template_specs.template_scope_id
  dimensions?: string;                 // SSOT: projection (renderer_config->>'dimensions')
  dpi?: number;                        // SSOT: projection (renderer_config->>'dpi')
  barcode_format?: string;             // SSOT: projection (renderer_config->>'barcode_format')
  /** Canonical jsonb column from `public.label_template_specs.renderer_config`
   *  — projection source for FE-derived fields like `active_version_id`. */
  renderer_config?: Record<string, unknown> | null;  // SSOT: label_template_specs.renderer_config (canonical)
  asset_refs?: unknown[] | null;       // SSOT: label_template_specs.asset_refs
  active_version_id?: string | null;   // Directory projection: renderer_config.active_version_id
}

export interface LabelTypeOption {
  value: string;
  label: string;
  rank?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown> | null;
}

export function nonEmptyString(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text.length ? text : null;
}

export function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function operatorTokenLabel(value: string | null | undefined): string {
  const normalized = nonEmptyString(value);
  if (!normalized) return '-';
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .replace(/\b(Dpi|Url|Id|Api|Rpc|Sql|Rls)\b/g, (match) => match.toUpperCase());
}

export function specDisplayName(spec: LabelSpec): string {
  return nonEmptyString(spec.template_key) ?? nonEmptyString(spec.name) ?? spec.id;
}

export function pageFromSpec(spec?: LabelSpec): Record<string, unknown> {
  const renderer = spec?.renderer_config ?? {};
  const page = renderer.page;
  if (page && typeof page === 'object' && !Array.isArray(page)) {
    return page as Record<string, unknown>;
  }
  if (spec?.dimensions?.toLowerCase().includes('a4')) {
    return { width_mm: 210, height_mm: 297, dpi: spec.dpi ?? 300, margin_mm: 5 };
  }
  if (spec?.dimensions?.toLowerCase().includes('a6')) {
    return { width_mm: 105, height_mm: 148, dpi: spec.dpi ?? 300, margin_mm: 4 };
  }
  return { width_inch: 4, height_inch: 6, dpi: spec?.dpi ?? 203, margin_inch: 0.12 };
}

export function blocksFromSpec(spec?: LabelSpec): Array<Record<string, unknown>> {
  const renderer = spec?.renderer_config ?? {};
  if (Array.isArray(renderer.blocks)) {
    return renderer.blocks.filter((block): block is Record<string, unknown> =>
      !!block && typeof block === 'object' && !Array.isArray(block),
    );
  }
  if (Array.isArray(renderer.zones)) {
    return renderer.zones
      .filter((zone): zone is Record<string, unknown> =>
        !!zone && typeof zone === 'object' && !Array.isArray(zone),
      )
      .map((zone, index) => ({
        type: String(zone.type ?? 'text'),
        binding: zone.binding ?? zone.value_path ?? zone.text ?? null,
        value_path: zone.value_path ?? zone.binding ?? null,
        x: Number(zone.x ?? 24),
        y: Number(zone.y ?? 24 + index * 28),
        width: Number(zone.width ?? zone.max_width ?? 240),
        height: Number(zone.height ?? zone.max_height ?? Math.max(Number(zone.size ?? 12) + 6, 18)),
        font: zone.font ?? null,
        font_size: Number(zone.size ?? zone.font_size ?? 12),
      }));
  }
  return [];
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export interface LabelDesignTemplateSummary {
  templateKey: string;
  labelType: string;
  blocks: Array<Record<string, unknown>>;
  page: Partial<PageConfig>;
  assets: Array<Record<string, unknown>>;
  assetsCount: number;
  firstBinding?: string | null;
}

export function labelDesignTemplateSummary(
  value: unknown,
  preferredLabelType?: string | null,
): LabelDesignTemplateSummary | null {
  const root = objectRecord(value);
  const templates = objectRecord(root.templates);
  const preferred = nonEmptyString(preferredLabelType);
  const templateEntry =
    preferred && templates[preferred] && typeof templates[preferred] === 'object' && !Array.isArray(templates[preferred])
      ? [preferred, templates[preferred]] as const
      : Object.entries(templates).find(([, template]) => !!template && typeof template === 'object' && !Array.isArray(template));
  if (!templateEntry) return null;
  const [labelType, templateValue] = templateEntry;
  const template = templateValue as Record<string, unknown>;
  const blocks = Array.isArray(template.blocks)
    ? template.blocks.filter((block): block is Record<string, unknown> =>
      !!block && typeof block === 'object' && !Array.isArray(block),
    )
    : [];
  const assets = Array.isArray(template.assets) ? template.assets : [];
  const page = objectRecord(template.page);
  const first = blocks[0];
  return {
    templateKey: nonEmptyString(template.template_key) ?? labelType,
    labelType,
    blocks,
    page,
    assets,
    assetsCount: assets.length,
    firstBinding: first
      ? nonEmptyString(first.value_path) ?? nonEmptyString(first.binding) ?? nonEmptyString(first.text)
      : null,
  };
}

export function describeDraftError(error?: Record<string, unknown> | null): string {
  if (!error) return 'Unknown label designer error';
  return String(error.message ?? error.code ?? 'Unknown label designer error');
}
