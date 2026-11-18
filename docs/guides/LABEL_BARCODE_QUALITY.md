# Label Barcode Quality (1D / Code128)

## Summary

Production label scan reliability depends on:
- **Printer dot grid alignment** (avoid fractional bar widths).
- **Sufficient module width** (dots/module) for the chosen printer DPI.
- **Quiet zones** around the barcode.

This repo renders Code128 as **vector bars** (rectangles) and snaps to the printer dot grid to improve scan reliability and rendering speed.

## SSOT (Design + Runtime)

- **Design geometry SSOT**: Figma (tagged `EXPORT` group) captured via `scripts/templates/capture-waybill-geometry.js --provider figma`.
- **Template SSOT for production rendering**: database rows seeded by migrations (immutable template versions) and selected via the settings ladder (`label_design`).
- **Printer capability SSOT (DPI + barcode render defaults)**: `label_print_profile` is resolved via the registry-driven settings ladder (`scope_type_registry.ladder_rank` + `scope_ladder_edges`; default order is Global < Tenant < Client < Sender < Source/Resource).
- **Barcode quality actions SSOT**: `label_render_policy.barcode` is resolved via the same registry-driven settings ladder (default order is Global < Tenant < Client < Sender < Source/Resource).

## Why barcodes become unreadable

Even with perfect rendering, there is a physical limit:
- If a barcode must fit into a fixed-width box at **203dpi**, very long **alphanumeric** values can require **< 1 dot/module**, which is effectively unscannable.
- Digit-heavy values compress better (Code128C), so they remain scannable at longer lengths.

## Policy: barcode rendering + quality gate

Barcode quality is driven by two categories:
- `label_print_profile`: **printer-aware rendering defaults** (DPI, quiet zone, dots/module).
- `label_render_policy.barcode`: **quality actions** (`warn|fail`) and per-barcode overrides.

### Gate mode (warn vs enforce)

`label_render_policy.barcode.gate_mode` controls how "fail" actions are interpreted:
- `warn_only` (default): never blocks label generation; surfaces as warnings in metadata/ops views.
- `enforce`: fail actions raise `barcode_quality_gate` and fail the render job.

### Example: print profile (global defaults)

```json
{
  "profile_key": "default_203dpi",
  "dpi": 203,
  "barcode": { "quiet_zone_modules": 10, "min_quiet_zone_modules": 4, "target_module_width_dots": 2, "hard_min_module_width_dots": 1 }
}
```

### Example: quality policy (client override: fail tracking if not scannable)

```json
{
  "barcode": {
    "gate_mode": "warn_only",
    "on_unscannable": "warn",
    "overrides": [
      {
        "value_path": "barcode_value",
        "on_unscannable": "fail",
        "on_at_risk": "fail",
        "on_non_vector": "fail"
      }
    ]
  }
}
```

## Observability (SSOT)

Each generated label job stores barcode metadata per block in `label_jobs.renderer_metadata.barcode` (engine used, dots/module, quiet zones, and whether policy would warn/fail). Use this for dashboards/alerts and for debugging scanner issues without logging raw barcode values.

## Ops queries (views)

- `label_job_barcode_summary_v`: one row per label job (engine, gate mode, warn flags, violations count).
- `label_job_barcode_blocks_v`: one row per barcode block (quality, dots/module, dpi, value_path).

## Synthetic barcode stress packs (no DB needed)

Generate deterministic packs that exercise long references (digits + alphanumeric) using the template snapshot embedded in `tmp-payload.json`:

```bash
node scripts/qa/generate-barcode-test-labels.js --dpi 203 --out-dir tmp/barcode-test-labels
node scripts/qa/generate-barcode-test-labels.js --dpi 300 --out-dir tmp/barcode-test-labels-dpi300
```

Each pack writes `barcode-test-pack.pdf` plus an `index.json` containing per-block barcode quality metadata.

## Vector vs PNG performance (label rendering)

Best practice for thermal labels is to render Code128 as **vector bars** (rectangles) and only fall back to PNG when necessary.

Why:
- Vector avoids image resampling and yields crisper bars when snapped to a printer dot grid.
- Vector is measurably faster and yields smaller PDFs than generating + embedding PNGs.

Run the repeatable micro-benchmark:

```bash
node scripts/benchmarks/label-barcode-render-bench.js --engine both --dpi 203 --iterations 200
```

