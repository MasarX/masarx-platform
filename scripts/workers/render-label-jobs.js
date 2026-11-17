#!/usr/bin/env node
// Background worker: lease label_jobs, render PDFs via pdf-lib, upload to labels bucket, complete jobs.
// Usage: ENV_FILE=config/env/.env.cloud node scripts/workers/render-label-jobs.js [--limit 5]

const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');
const bwipjs = require('bwip-js');
const { loadEnv } = require('../utils/load-env');
const { fitTextToBox, widestLineWidth } = require('../render/text-fit');
const { measureBidiVisualWidthWithFallback, drawBidiVisualRunsWithFallback } = require('../render/text-measure');
const { drawCode128 } = require('../render/draw-code128');
const { evaluateBarcodeQualityPolicy } = require('../render/barcode-quality-policy');
const { shouldRenderBlock } = require('../render/block-conditions');
const { hasArabic, toBidiVisualOrder } = require('../render/text-shape');
const { resolveExecutionContext, buildTraceHeaders, emitTraceWithContext } = require('../utils/trace-context');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const JWT_COMPACT_PATTERN = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/;
const isCompactJwtToken = (token) => JWT_COMPACT_PATTERN.test(String(token || '').trim());
const resolveStorageAdminKeyCandidates = () => {
  const ordered = [
    process.env.SUPABASE_SECRET_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY,
  ];
  const unique = [];
  for (const raw of ordered) {
    const key = String(raw || '').trim();
    if (!key || unique.includes(key)) continue;
    unique.push(key);
  }
  const compact = unique.filter((candidate) => isCompactJwtToken(candidate));
  if (compact.length) {
    const compactSet = new Set(compact);
    return [...compact, ...unique.filter((candidate) => !compactSet.has(candidate))];
  }
  return unique;
};
const STORAGE_ADMIN_KEY = resolveStorageAdminKeyCandidates()[0] || '';
const DATABASE_URL = process.env.DATABASE_URL;
const LABEL_BUCKET = process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';
const ASSET_BUCKET = process.env.LABEL_ASSET_BUCKET || process.env.LABEL_RENDER_ASSETS_BUCKET || 'label-render-assets';

if (!SUPABASE_URL || !STORAGE_ADMIN_KEY || !DATABASE_URL) {
  console.error('Missing SUPABASE_URL or storage admin key (SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY) or DATABASE_URL.');
  process.exit(1);
}

const STAGE_LOGS = process.env.LABEL_WORKER_STAGE_LOG === '1';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 && args[limitIdx + 1] ? Number(args[limitIdx + 1]) : 5;
const orgIdx = args.indexOf('--org-id');
const orgId = orgIdx !== -1 && args[orgIdx + 1] ? String(args[orgIdx + 1]) : null;
const jobIdx = args.indexOf('--job-id');
const onlyJobId = jobIdx !== -1 && args[jobIdx + 1] ? String(args[jobIdx + 1]) : null;
const concurrencyIdx = args.indexOf('--concurrency') !== -1 ? args.indexOf('--concurrency') : args.indexOf('--workers');
const concurrencyRaw = concurrencyIdx !== -1 && args[concurrencyIdx + 1] ? Number(args[concurrencyIdx + 1]) : 1;
const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.floor(concurrencyRaw) : 1;

const correlationIdIdx = args.indexOf('--correlation-id');
const correlationIdArg = correlationIdIdx !== -1 && args[correlationIdIdx + 1] ? String(args[correlationIdIdx + 1]) : null;

const ctx = resolveExecutionContext({ operation: 'worker.render_label_jobs', correlationId: correlationIdArg });

const supabase = createClient(SUPABASE_URL, STORAGE_ADMIN_KEY, {
  auth: { persistSession: false },
  global: { headers: buildTraceHeaders(ctx) },
});
const pg = new Client({ connectionString: DATABASE_URL });

const normalizeColor = (color) => {
  if (!color) return rgb(0, 0, 0);

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const asRgb = (r, g, b) => rgb(clamp01(r), clamp01(g), clamp01(b));

  if (typeof color === 'string') {
    const s = color.trim();
    const hex = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (hex) {
      const raw = hex[1];
      const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
      const r = parseInt(full.slice(0, 2), 16) / 255;
      const g = parseInt(full.slice(2, 4), 16) / 255;
      const b = parseInt(full.slice(4, 6), 16) / 255;
      return asRgb(r, g, b);
    }

    const rgbMatch = s.match(/^rgba?\\(([^)]+)\\)$/i);
    if (rgbMatch) {
      const parts = rgbMatch[1].split(',').map((p) => p.trim());
      const nums = parts.slice(0, 3).map((p) => Number(p));
      if (nums.every((n) => Number.isFinite(n))) {
        return asRgb(nums[0] / 255, nums[1] / 255, nums[2] / 255);
      }
    }

    const named = s.toLowerCase();
    if (named === 'black') return asRgb(0, 0, 0);
    if (named === 'white') return asRgb(1, 1, 1);
  }

  if (typeof color === 'object') {
    const r = Number(color.r);
    const g = Number(color.g);
    const b = Number(color.b);
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      const scale = Math.max(r, g, b) > 1 ? 255 : 1;
      return asRgb(r / scale, g / scale, b / scale);
    }
  }

  return rgb(0, 0, 0);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retry = async (fn, opts = {}) => {
  const attempts = Number.isFinite(Number(opts.attempts)) ? Math.max(1, Math.floor(Number(opts.attempts))) : 1;
  const baseDelayMs = Number.isFinite(Number(opts.baseDelayMs)) ? Math.max(0, Math.floor(Number(opts.baseDelayMs))) : 0;
  const label = typeof opts.label === 'string' ? opts.label : 'operation';
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      emitTraceWithContext(ctx, 'warn', {
        event: 'label_worker_retry',
        label,
        attempt,
        attempts,
        delay_ms: delay,
        error_message: err?.message || String(err),
      });
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastErr;
};

const selectFont = async (pdfDoc, cache, name) => {
  const n = (name || 'helvetica').toLowerCase();
  if (cache.has(n)) return cache.get(n);
  const p = (async () => {
    switch (n) {
      case 'helvetica-bold':
      case 'helvetica_bold':
      case 'bold':
        return await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      case 'courier':
      case 'barcode':
        return await pdfDoc.embedFont(StandardFonts.Courier);
      case 'times':
      case 'times-roman':
        return await pdfDoc.embedFont(StandardFonts.TimesRoman);
      default:
        return await pdfDoc.embedFont(StandardFonts.Helvetica);
    }
  })();
  cache.set(n, p);
  return p;
};

const encodeCode128B = (value) => {
  // Minimal subset: delegate to pdf-lib's built-in Code128 support? Not available. Keep the existing util.
  // For brevity, reuse edge logic: fallback to text if oversized.
  if (!value) return null;
  if (value.length > 80) return null;
  // Very simple: let pdf-lib render text as barcode? Not supported. We keep edge’s pattern? Too long for this worker.
  return { textOnly: value };
};

const resolvePathValue = (root, pathStr) => {
  if (!root || !pathStr) return undefined;
  const parts = pathStr.matchAll(/([^[.\]]+)|\[(\d+)\]/g);
  let cur = root;
  for (const m of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (m[1] !== undefined) cur = cur[m[1]];
    else if (m[2] !== undefined) cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
  }
  return cur;
};

const stringify = (v, fb) => {
  if (v === undefined || v === null) return fb || '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((item) => (item == null ? '' : String(item))).join(', ');
  return fb || '';
};

const sanitizePdfText = (value) => String(value ?? '').replace(/\uFFFD/g, '?');

const fetchAsset = async (key, cache) => {
  if (!key) return null;
  const c = cache || new Map();
  if (c.has(key)) return await c.get(key);

  const promise = (async () => {
    const dataUrlMatch = key.match(/^data:([^;]+);base64,([\s\S]+)$/i);
    if (dataUrlMatch) {
      return Buffer.from(dataUrlMatch[2].replace(/\s+/g, ''), 'base64');
    }
    const { data, error } = await supabase.storage.from(ASSET_BUCKET).download(key);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  })();

  c.set(key, promise);
  const bytes = await promise;
  if (!bytes) c.delete(key);
  else c.set(key, bytes);
  return bytes;
};

const renderTemplate = async (payload, snapshot, jobOrgId, sharedAssetCache) => {
  const rendererConfig = snapshot.renderer_config || {};
  const pageCfg = rendererConfig.page || {};
  const widthPoints = Math.max(72, Math.round((pageCfg.width_inch || 4) * 72));
  const heightPoints = Math.max(72, Math.round((pageCfg.height_inch || 6) * 72));
  const orientation = (pageCfg.orientation || 'portrait') === 'landscape' ? 'landscape' : 'portrait';
  const pdfDoc = await PDFDocument.create();
  const pageSize = orientation === 'landscape' ? [heightPoints, widthPoints] : [widthPoints, heightPoints];
  const page = pdfDoc.addPage(pageSize);
  const renderStage = (stage, extra = {}) => {
    if (!STAGE_LOGS) return;
    emitTraceWithContext(ctx, 'info', { event: 'label_render_stage', stage, ...extra });
  };
  const fontCache = new Map();
  let fontkitRegistered = false;
  const assetCache = sharedAssetCache || new Map();
  const policy = payload && typeof payload === 'object' && payload.label_render_policy && typeof payload.label_render_policy === 'object'
    ? payload.label_render_policy
    : {};
  const barcodePolicy = policy && typeof policy === 'object' && policy.barcode && typeof policy.barcode === 'object'
    ? policy.barcode
    : {};
  const printProfile = payload && typeof payload === 'object' && payload.label_print_profile && typeof payload.label_print_profile === 'object'
    ? payload.label_print_profile
    : {};
  const barcodePrintProfile = printProfile && typeof printProfile === 'object' && printProfile.barcode && typeof printProfile.barcode === 'object'
    ? printProfile.barcode
    : {};
  const textDefaults = policy.text_defaults && typeof policy.text_defaults === 'object' ? policy.text_defaults : {};
  const arabicPolicy = policy.arabic && typeof policy.arabic === 'object' ? policy.arabic : {};
  const arabicEnabled = arabicPolicy.enabled === true;
  const arabicDirection = arabicPolicy.direction;
  const arabicFontRegularKey = typeof arabicPolicy.font_asset_regular === 'string' ? arabicPolicy.font_asset_regular.trim() : '';
  const arabicFontBoldKey = typeof arabicPolicy.font_asset_bold === 'string' ? arabicPolicy.font_asset_bold.trim() : '';

  const ensureFontkitRegistered = () => {
    if (fontkitRegistered) return;
    pdfDoc.registerFontkit(fontkit);
    fontkitRegistered = true;
  };

  const embedFontFromAsset = async (assetKey) => {
    if (!assetKey) throw new Error('font asset key is required');
    const cacheKey = `asset_font:${assetKey}`;
    if (fontCache.has(cacheKey)) return fontCache.get(cacheKey);
    const p = (async () => {
      const bytes = await fetchAsset(assetKey, assetCache);
      if (!bytes) throw new Error(`font asset not found: ${assetKey}`);
      ensureFontkitRegistered();
      return await pdfDoc.embedFont(bytes, { subset: true });
    })();
    fontCache.set(cacheKey, p);
    return p;
  };

  const selectTextFont = async (blockFont, rawText) => {
    if (!arabicEnabled || !hasArabic(rawText)) return selectFont(pdfDoc, fontCache, blockFont);
    if (!arabicFontRegularKey) {
      throw new Error('label_render_policy.arabic.enabled=true but arabic.font_asset_regular is missing');
    }
    const isBold = /bold/i.test(String(blockFont || '')) || String(blockFont || '').toLowerCase() === 'bold';
    const key = isBold ? (arabicFontBoldKey || arabicFontRegularKey) : arabicFontRegularKey;
    return embedFontFromAsset(key);
  };

  const resolveFontName = (blockFont) => {
    const raw = String(blockFont || '').trim();
    if (!raw) return String(textDefaults.font_regular || 'Helvetica');
    const lower = raw.toLowerCase();
    if (lower === 'regular') return String(textDefaults.font_regular || 'Helvetica');
    if (lower === 'bold') return String(textDefaults.font_bold || 'Helvetica-Bold');
    return raw;
  };

  const resolveMinFontSize = (block) => {
    const raw = block && typeof block === 'object' ? block.min_font_size : undefined;
    const fromPolicy = textDefaults.min_font_size;
    const asNum = Number(raw != null ? raw : (fromPolicy != null ? fromPolicy : 6));
    return Number.isFinite(asNum) && asNum > 0 ? asNum : 6;
  };

  const resolveHardMinFontSize = (block, minSize) => {
    const raw = block && typeof block === 'object' ? block.hard_min_font_size : undefined;
    const fromPolicy = textDefaults.hard_min_font_size;
    const asNum = Number(raw != null ? raw : fromPolicy);
    const resolved = Number.isFinite(asNum) && asNum > 0 ? asNum : 0.01;
    if (Number.isFinite(Number(minSize)) && Number(minSize) > 0) return Math.min(resolved, Number(minSize));
    return resolved;
  };

  const resolveLineHeightFactor = (block) => {
    const raw = block && typeof block === 'object' ? block.line_height_factor : undefined;
    const fromPolicy = textDefaults.line_height_factor;
    const asNum = Number(raw != null ? raw : fromPolicy);
    return Number.isFinite(asNum) && asNum > 0 ? asNum : undefined;
  };

  const resolveOverflow = (block) => (
    (block && typeof block === 'object' && typeof block.text_overflow === 'string' && block.text_overflow.trim())
      ? block.text_overflow.trim()
      : (typeof textDefaults.overflow === 'string' && textDefaults.overflow.trim() ? textDefaults.overflow.trim() : undefined)
  );
  const assetDefs = Array.isArray(rendererConfig.assets) ? rendererConfig.assets : [];
  const assetRefs = Array.isArray(snapshot.asset_refs) ? snapshot.asset_refs : [];
  const assetPathByName = new Map(
    [...assetDefs, ...assetRefs]
      .filter((a) => a && typeof a === 'object')
      .filter((a) => typeof a.name === 'string' && a.name.trim().length > 0 && typeof a.path === 'string' && a.path.trim().length > 0)
      .map((a) => [a.name.trim(), a.path.trim()])
  );
  const assetContentTypeByName = new Map(
    [...assetDefs, ...assetRefs]
      .filter((a) => a && typeof a === 'object')
      .filter((a) => typeof a.name === 'string' && a.name.trim().length > 0 && typeof a.content_type === 'string' && a.content_type.trim().length > 0)
      .map((a) => [a.name.trim(), a.content_type.trim()])
  );
  const resolveAssetKey = (ref) => {
    if (!ref || typeof ref !== 'string') return ref;
    const trimmed = ref.trim();
    if (!trimmed) return trimmed;
    return assetPathByName.get(trimmed) || trimmed;
  };
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const computeBwipHeightMm = (heightPt) => {
    if (typeof heightPt !== 'number' || heightPt <= 0) return 15;
    const mm = (heightPt / 72) * 25.4;
    return clamp(Math.round(mm), 8, 25);
  };
  const computeBwipScale = (moduleWidth) => {
    if (typeof moduleWidth !== 'number' || moduleWidth <= 0) return 3;
    return clamp(Math.round(moduleWidth * 3.2), 1, 4);
  };
  const ensureBarcodeAsset = async (value, opts = {}) => {
    if (!value || !jobOrgId) return null;
    const bwipHeight = computeBwipHeightMm(opts.height_pt);
    const scale = computeBwipScale(opts.module_width);
    const assetPath = `${jobOrgId}/barcodes/${value}-h${bwipHeight}-s${scale}.png`;
    renderStage('barcode_asset_lookup', { asset_path: assetPath });
    // Prefer in-process cache; avoid round-trip download on the hot path.
    if (assetCache.has(assetPath)) {
      const cached = await assetCache.get(assetPath);
      if (!cached) return null;
      return { bytes: cached, path: assetPath, cache_hit: true, bwip_height_mm: bwipHeight, bwip_scale: scale };
    }

    const promise = (async () => {
      renderStage('barcode_asset_generate', { asset_path: assetPath });
      const png = await bwipjs.toBuffer({
        bcid: 'code128',
        text: value,
        scale,
        height: bwipHeight,
        includetext: false,
        paddingwidth: 12,
        paddingheight: 4,
        backgroundcolor: 'FFFFFF',
        barcolor: '000000',
      });
      // Best-effort upload for observability/debugging; label render does not depend on it.
      renderStage('barcode_asset_upload_start', { asset_path: assetPath });
      await supabase.storage.from(ASSET_BUCKET).upload(assetPath, png, {
        contentType: 'image/png',
        upsert: true,
      }).catch(() => {});
      renderStage('barcode_asset_upload_done', { asset_path: assetPath, size_bytes: png?.length });
      return png;
    })();

    assetCache.set(assetPath, promise);
    const png = await promise;
    assetCache.set(assetPath, png);
    return { bytes: png, path: assetPath, cache_hit: false, bwip_height_mm: bwipHeight, bwip_scale: scale };
  };

  const resolveBarcodeDpi = () => {
    const raw = printProfile.dpi ?? barcodePolicy.dpi ?? pageCfg.dpi;
    const d = Number(raw);
    return Number.isFinite(d) && d > 0 ? d : 203;
  };

  const resolveBarcodeInt = (block, key, fallback) => {
    const raw = (block && typeof block === 'object' && block[key] != null)
      ? block[key]
      : (barcodePrintProfile && typeof barcodePrintProfile === 'object' && barcodePrintProfile[key] != null)
        ? barcodePrintProfile[key]
        : barcodePolicy[key];
    const n = Number(raw);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  };

  const barcodeMeta = [];
  const pushBarcodeMeta = (block, meta, engine, extra = {}) => {
    const m = meta && typeof meta === 'object' ? meta : {};
    const e = extra && typeof extra === 'object' ? extra : {};
    barcodeMeta.push({
      engine: engine || 'code128_vector',
      block_type: block?.type || null,
      value_path: typeof block?.value_path === 'string' ? block.value_path : null,
      asset_ref: typeof block?.asset_ref === 'string' ? block.asset_ref : null,
      align: typeof block?.align === 'string' ? block.align : null,
      input_length: m.input_length ?? null,
      module_width_dots: m.module_width_dots ?? null,
      quiet_zone_modules: m.quiet_zone_modules ?? null,
      total_modules: m.total_modules ?? null,
      dpi: m.dpi ?? null,
      quality: m.quality ?? null,
      fractional_module_width: m.fractional_module_width ?? null,
      bwip_scale: e.bwip_scale ?? null,
      bwip_height_mm: e.bwip_height_mm ?? null,
      asset_cache_hit: e.asset_cache_hit ?? null,
      fallback_reason: e.fallback_reason ?? null,
      vector_error_code: e.vector_error_code ?? null,
    });
  };

  const blocks = Array.isArray(rendererConfig.blocks) ? rendererConfig.blocks : [];

  let blockIndex = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (!shouldRenderBlock(block, payload, resolvePathValue)) {
      renderStage('block_skip', { idx: blockIndex, type: block.type, section_key: block.section_key || null, value_path: block.value_path || null, asset_ref: block.asset_ref || null });
      blockIndex += 1;
      continue;
    }
    renderStage('block_start', { idx: blockIndex, type: block.type, section_key: block.section_key || null, value_path: block.value_path || null, asset_ref: block.asset_ref || null });
    blockIndex += 1;
    const x = typeof block.x === 'number' ? block.x : 0;
    const y = typeof block.y === 'number' ? block.y : 0;
    if (block.type === 'rect') {
      page.drawRectangle({
        x, y,
        width: block.width || 0,
        height: block.height || 0,
        borderWidth: block.stroke_width || 1,
        borderColor: normalizeColor(block.color),
      });
      continue;
    }
    if (block.type === 'line') {
      const x2 = typeof block.width === 'number' ? block.width : x;
      const y2 = typeof block.height === 'number' ? block.height : y;
      page.drawLine({ start: { x, y }, end: { x: x2, y: y2 }, thickness: block.stroke_width || 1, color: normalizeColor(block.color) });
      continue;
    }
    if (block.type === 'image') {
      const assetRef = block.asset_ref || block.value_path;
      let embedBytes = null;
      let resolvedKey = null;
      if (assetRef === 'barcode_asset_path') {
        const barVal = stringify(
          resolvePathValue(payload, block.value_path) ||
          resolvePathValue(payload, 'barcode_value') ||
          resolvePathValue(payload, 'tracking_number') ||
          resolvePathValue(payload, 'reference_number'),
          ''
        );
        if (barVal) {
          let vectorAttempted = false;
          let vectorErrorCode = null;
          try {
            const bw = Number(block.width);
            const bh = Number(block.height);
            if (Number.isFinite(bw) && bw > 0 && Number.isFinite(bh) && bh > 0) {
              vectorAttempted = true;
              const meta = drawCode128(page, barVal, {
                x,
                y,
                width: bw,
                height: bh,
                align: block.align,
                dpi: resolveBarcodeDpi(),
                base_module_width_pt: block.module_width,
                max_scale: block.max_scale,
                preferred_quiet_zone_modules: resolveBarcodeInt(block, 'quiet_zone_modules', 10),
                min_quiet_zone_modules: resolveBarcodeInt(block, 'min_quiet_zone_modules', 4),
                target_module_width_dots: resolveBarcodeInt(block, 'target_module_width_dots', 2),
                hard_min_module_width_dots: resolveBarcodeInt(block, 'hard_min_module_width_dots', 1),
                snap_to_dots: true,
                color: normalizeColor(block.color),
              });
              pushBarcodeMeta(block, meta, 'code128_vector');
              continue;
            }
          } catch (err) {
            vectorErrorCode = err?.code || 'vector_error';
            renderStage('barcode_vector_failed', { value_path: block.value_path || null, error: err?.message || String(err) });
          }
          const asset = await ensureBarcodeAsset(barVal, { height_pt: block.height, module_width: block.module_width });
          if (asset && asset.bytes) {
            pushBarcodeMeta(
              block,
              { input_length: String(barVal).length, dpi: resolveBarcodeDpi(), quality: 'png' },
              'code128_png_bwip',
              {
                bwip_scale: asset.bwip_scale ?? null,
                bwip_height_mm: asset.bwip_height_mm ?? null,
                asset_cache_hit: asset.cache_hit ?? null,
                fallback_reason: vectorErrorCode ? 'vector_failed' : 'vector_skipped',
                vector_error_code: vectorErrorCode,
              }
            );
          }
          embedBytes = asset?.bytes || null;
        }
      }
      if (!embedBytes) {
        resolvedKey = resolveAssetKey(assetRef);
        renderStage('image_asset_fetch', { asset_ref: assetRef || null, resolved_key: resolvedKey || null });
        embedBytes = await fetchAsset(resolvedKey, assetCache);
        renderStage('image_asset_fetched', { resolved_key: resolvedKey || null, size_bytes: embedBytes?.byteLength || embedBytes?.length || null });
      }
      if (!embedBytes) continue;
      const contentType = typeof assetRef === 'string' ? assetContentTypeByName.get(assetRef.trim()) : null;
      const isJpg = (
        (typeof contentType === 'string' && /jpe?g/i.test(contentType)) ||
        (typeof resolvedKey === 'string' && /\\.jpe?g$/i.test(resolvedKey))
      );
      const embed = isJpg ? await pdfDoc.embedJpg(embedBytes) : await pdfDoc.embedPng(embedBytes);
      const targetWidth = block.width || embed.width;
      const targetHeight = block.height || embed.height;
      const ratio = Math.min(targetWidth / embed.width, targetHeight / embed.height);
      const allowUpscale = !!block.allow_upscale;
      const maxScale = typeof block.max_scale === 'number' ? block.max_scale : (allowUpscale ? 5 : 1);
      const scale = Math.min(allowUpscale ? ratio : Math.min(ratio, 1), maxScale);
      const drawWidth = embed.width * scale;
      const drawHeight = embed.height * scale;
      let drawX = x;
      if (block.align === 'center') drawX = x - drawWidth / 2;
      else if (block.align === 'right') drawX = x - drawWidth;
      const drawY = y;
      page.drawImage(embed, { x: drawX, y: drawY, width: drawWidth, height: drawHeight });
      continue;
    }
    if (block.type === 'text') {
      const rawVal = stringify(resolvePathValue(payload, block.value_path), block.fallback);
      if (!rawVal) continue;
      const useArabic = arabicEnabled && hasArabic(rawVal);
      const val = sanitizePdfText(rawVal);
      const resolvedFontName = resolveFontName(block.font);
      const latinFont = await selectFont(pdfDoc, fontCache, resolvedFontName);
      const arabicFont = useArabic ? await selectTextFont(resolvedFontName, val) : null;
      const font = useArabic ? arabicFont : latinFont;
      const size = block.font_size || 12;
      const maxWidth = block.max_width || block.width || (page.getWidth() - 12);
      const maxHeight = block.max_height || block.height || null;
      const minSize = resolveMinFontSize(block);
      const hardMinSize = resolveHardMinFontSize(block, minSize);
      const textForFit = useArabic ? toBidiVisualOrder(val, arabicDirection) : val;
      const measureTextWidth = useArabic
        ? (text, s) => measureBidiVisualWidthWithFallback(text, s, arabicFont, latinFont)
        : null;
      const fitted = fitTextToBox(textForFit, font, size, maxWidth, maxHeight, {
        minSize: minSize,
        hardMinSize: hardMinSize,
        overflow: resolveOverflow(block),
        wrap: !!block.wrap,
        lineHeightFactor: resolveLineHeightFactor(block),
        measureTextWidth,
      });
      if (fitted.fits === false) {
        const err = new Error(`layout_unfit: text block does not fit (${block.value_path || block.fallback || 'text'})`);
        err.code = 'layout_unfit';
        err.meta = { block: block.value_path || block.fallback || 'text', maxWidth, maxHeight, minSize, hardMinSize, fitted };
        throw err;
      }
      const drawLines = fitted.lines;
      const width = widestLineWidth(font, drawLines, fitted.size, measureTextWidth);
      const textHeight = fitted.textHeight;
      const totalHeight = fitted.totalHeight;
      const lineHeight = fitted.lineHeight;

      let boxY = y;
      if (typeof block.height === 'number' && block.height > 0) {
        if (block.valign === 'top') boxY = y + Math.max(0, block.height - totalHeight);
        else if (block.valign === 'middle') boxY = y + Math.max(0, (block.height - totalHeight) / 2);
      }

      const descentFactor = typeof block.baseline_descent_factor === 'number' ? block.baseline_descent_factor : 0.2;
      const rotate = typeof block.rotation === 'number' ? degrees(block.rotation) : undefined;
      const color = normalizeColor(block.color);

      if (drawLines.length <= 1) {
        const line = drawLines[0] || '';
        const lineWidth = measureTextWidth ? measureTextWidth(line, fitted.size) : font.widthOfTextAtSize(line, fitted.size);
        let drawX = x;
        if (block.align === 'center') drawX = x - lineWidth / 2;
        else if (block.align === 'right') drawX = x - lineWidth;
        const drawY = boxY + (textHeight * descentFactor);
        if (useArabic) {
          drawBidiVisualRunsWithFallback(page, line, { x: drawX, y: drawY, size: fitted.size, arabicFont, latinFont, color, rotate });
        } else {
          const drawOpts = { x: drawX, y: drawY, size: fitted.size, font, color };
          if (rotate) drawOpts.rotate = rotate;
          page.drawText(line, drawOpts);
        }
      } else {
        for (let i = 0; i < drawLines.length; i += 1) {
          const line = drawLines[i] ?? '';
          const lineWidth = measureTextWidth ? measureTextWidth(line, fitted.size) : font.widthOfTextAtSize(line, fitted.size);
          let drawX = x;
          if (block.align === 'center') drawX = x - lineWidth / 2;
          else if (block.align === 'right') drawX = x - lineWidth;

          // Draw from top-to-bottom within the fitted wrapped block.
          const lineBoxBottom = boxY + totalHeight - (lineHeight * (i + 1));
          const drawY = lineBoxBottom + (textHeight * descentFactor);
          if (useArabic) {
            drawBidiVisualRunsWithFallback(page, line, { x: drawX, y: drawY, size: fitted.size, arabicFont, latinFont, color, rotate });
          } else {
            const drawOpts = { x: drawX, y: drawY, size: fitted.size, font, color };
            if (rotate) drawOpts.rotate = rotate;
            page.drawText(line, drawOpts);
          }
        }
      }
      continue;
    }
    if (block.type === 'barcode') {
      const rawVal = stringify(resolvePathValue(payload, block.value_path), block.fallback);
      if (!rawVal) continue;
      const val = rawVal;
      const targetHeight = block.height || 0;
      const reservedBottom = typeof block.reserve_bottom === 'number' ? Math.max(0, block.reserve_bottom) : 0;
      const availableHeight = targetHeight > 0 ? Math.max(0, targetHeight - reservedBottom) : targetHeight;
      let vectorAttempted = false;
      let vectorErrorCode = null;
      try {
        const bw = Number(block.max_width || block.width || (page.getWidth() - 12));
        const bh = Number(availableHeight || block.height || 0);
        if (Number.isFinite(bw) && bw > 0 && Number.isFinite(bh) && bh > 0) {
          vectorAttempted = true;
          const meta = drawCode128(page, val, {
            x,
            y: y + reservedBottom,
            width: bw,
            height: bh,
            align: block.align,
            dpi: resolveBarcodeDpi(),
            base_module_width_pt: block.module_width,
            max_scale: block.max_scale,
            preferred_quiet_zone_modules: resolveBarcodeInt(block, 'quiet_zone_modules', 10),
            min_quiet_zone_modules: resolveBarcodeInt(block, 'min_quiet_zone_modules', 4),
            target_module_width_dots: resolveBarcodeInt(block, 'target_module_width_dots', 2),
            hard_min_module_width_dots: resolveBarcodeInt(block, 'hard_min_module_width_dots', 1),
            snap_to_dots: true,
            color: normalizeColor(block.color),
          });
          pushBarcodeMeta(block, meta, 'code128_vector');
          continue;
        }
      } catch (err) {
        vectorErrorCode = err?.code || 'vector_error';
        renderStage('barcode_vector_failed', { value_path: block.value_path || null, error: err?.message || String(err) });
      }
      const asset = await ensureBarcodeAsset(val, { height_pt: availableHeight || block.height, module_width: block.module_width });
      if (asset && asset.bytes) {
        const embed = await pdfDoc.embedPng(asset.bytes);
        const targetWidth = block.width || embed.width;
        const ratio = Math.min(targetWidth / embed.width, (availableHeight || (block.height || embed.height)) / embed.height);
        const maxScale = typeof block.max_scale === 'number' ? block.max_scale : 5;
        const scale = Math.min(ratio, maxScale);
        const drawWidth = embed.width * scale;
        const drawHeight = embed.height * scale;
        let drawX = x;
        if (block.align === 'center') drawX = x - drawWidth / 2;
        else if (block.align === 'right') drawX = x - drawWidth;
        const drawY = y + reservedBottom;
        page.drawImage(embed, { x: drawX, y: drawY, width: drawWidth, height: drawHeight });
        pushBarcodeMeta(
          block,
          { input_length: String(val).length, dpi: resolveBarcodeDpi(), quality: 'png' },
          'code128_png_bwip',
          {
            bwip_scale: asset.bwip_scale ?? null,
            bwip_height_mm: asset.bwip_height_mm ?? null,
            asset_cache_hit: asset.cache_hit ?? null,
            fallback_reason: vectorErrorCode ? 'vector_failed' : (vectorAttempted ? 'vector_failed' : 'vector_skipped'),
            vector_error_code: vectorErrorCode,
          }
        );
      } else {
        pushBarcodeMeta(
          block,
          { input_length: String(val).length, dpi: resolveBarcodeDpi(), quality: 'text' },
          'barcode_text_fallback',
          { fallback_reason: vectorErrorCode ? 'vector_failed' : 'asset_unavailable', vector_error_code: vectorErrorCode }
        );
        const displayVal = sanitizePdfText(rawVal);
        const useArabic = arabicEnabled && hasArabic(rawVal);
        const resolvedFontName = resolveFontName(block.font);
        const latinFont = await selectFont(pdfDoc, fontCache, resolvedFontName);
        const arabicFont = useArabic ? await selectTextFont(resolvedFontName, displayVal) : null;
        const font = useArabic ? arabicFont : latinFont;
        const textForFit = useArabic ? toBidiVisualOrder(displayVal, arabicDirection) : displayVal;
        const minSize = resolveMinFontSize(block);
        const hardMinSize = resolveHardMinFontSize(block, minSize);
        const measureTextWidth = useArabic
          ? (text, s) => measureBidiVisualWidthWithFallback(text, s, arabicFont, latinFont)
          : null;
        const fitted = fitTextToBox(
          textForFit,
          font,
          block.font_size || 11,
          block.max_width || block.width || (page.getWidth() - 12),
          block.max_height || block.height || null,
          {
            minSize,
            hardMinSize,
            overflow: 'shrink',
            wrap: false,
            measureTextWidth,
          }
        );
        if (fitted.fits === false) {
          const err = new Error(`layout_unfit: barcode text fallback does not fit (${block.value_path || block.fallback || 'barcode'})`);
          err.code = 'layout_unfit';
          err.meta = { block: block.value_path || block.fallback || 'barcode', minSize, hardMinSize, fitted };
          throw err;
        }
        const line = fitted.lines[0] || '';
        const rotate = typeof block.rotation === 'number' ? degrees(block.rotation) : undefined;
        const color = normalizeColor(block.color);
        if (useArabic) {
          drawBidiVisualRunsWithFallback(page, line, { x, y, size: fitted.size, arabicFont, latinFont, color, rotate });
        } else {
          const drawOpts = { x, y, size: fitted.size, font, color };
          if (rotate) drawOpts.rotate = rotate;
          page.drawText(line, drawOpts);
        }
      }
    }
  }

  return { bytes: new Uint8Array(await pdfDoc.save()), barcodeMeta };
};

const leaseJob = async () => {
  const { data, error } = await supabase.functions.invoke('label-renderer', {
    body: { max_jobs: 0 }, // no-op lease; we will lease via DB functions directly
  });
  if (error) return null;
  return data;
};

const leaseJobDb = async () => {
  // Use to_json to avoid composite string parsing issues
  const { rows } = await pg.query('select to_json(lease_label_job($1::uuid, 60, $2::uuid)) as job', [orgId, onlyJobId]);
  if (!rows.length || !rows[0].job || !rows[0].job.id) return null;
  return rows[0].job;
};

const completeJobDb = async (jobId, status, outputPath, sizeBytes, metadata, errorReason) => {
  await pg.query(
    "select complete_label_job($1,$2,$3,$4,$5,$6)",
    [
      jobId,
      status,
      outputPath,
      sizeBytes ? sizeBytes.toString() : null,
      metadata ? JSON.stringify(metadata) : null,
      errorReason || null,
    ]
  );
};

const composePayload = async (jobId) => {
  const { rows } = await pg.query("select compose_label_payload($1) as payload", [jobId]);
  return rows[0].payload;
};

const processJob = async (job, sharedAssetCache) => {
  const stage = (name, extra = {}) => {
    if (!STAGE_LOGS) return;
    console.log(JSON.stringify({ event: 'label_job_stage', stage: name, job_id: job?.id, org_id: job?.organization_id, ...extra }));
  };
  const t0 = Date.now();
  let composeMs = 0;
  let renderMs = 0;
  let uploadMs = 0;
  let payload = {};
  let snapshot = {};
  let templateKey = 'unknown';
  let templateVersion = null;
  let barcodeBlocks = [];
  let barcodeEngines = [];
  let barcodeEngine = null;
  let barcodePolicyEval = { should_fail: false, fail_reason: null, should_warn: false, violations: [] };
  let barcodePolicyGateMode = 'warn_only';
  let barcodePolicyWouldFail = false;
  let labelRenderPolicyResolutionId = null;
  let labelPrintProfileResolutionId = null;
  try {
    stage('compose_start');
    const composeStart = Date.now();
    const composed = await composePayload(job.id);
    composeMs = Date.now() - composeStart;
    stage('compose_done', { compose_ms: composeMs });
    payload = composed?.payload || {};
    snapshot = composed?.job?.template || composed?.job?.template_snapshot || {};
    templateKey = snapshot.template_key || snapshot?.renderer_config?.template_key || 'unknown';
    templateVersion = snapshot.version || snapshot.template_version || null;
    labelRenderPolicyResolutionId = payload?.label_render_policy_resolution?.settings_resolution_id || null;
    labelPrintProfileResolutionId = payload?.label_print_profile_resolution?.settings_resolution_id || null;
    stage('render_start', { template_key: templateKey, template_version: templateVersion });
    const renderStart = Date.now();
    const rendered = await renderTemplate(payload, snapshot, job.organization_id, sharedAssetCache);
    const bytes = rendered.bytes;
    barcodeBlocks = Array.isArray(rendered.barcodeMeta) ? rendered.barcodeMeta : [];
    barcodeEngines = Array.from(new Set(barcodeBlocks.map((b) => b?.engine).filter(Boolean)));
    barcodeEngine = barcodeEngines.length === 1 ? barcodeEngines[0] : barcodeEngines.length > 1 ? 'mixed' : null;
    const barcodePolicy = payload && typeof payload === 'object' && payload.label_render_policy && typeof payload.label_render_policy === 'object'
      ? payload.label_render_policy?.barcode
      : null;
    barcodePolicyGateMode = (() => {
      const raw = barcodePolicy && typeof barcodePolicy === 'object' ? barcodePolicy.gate_mode : null;
      const mode = String(raw || '').trim().toLowerCase();
      return mode === 'enforce' ? 'enforce' : 'warn_only';
    })();
    barcodePolicyEval = evaluateBarcodeQualityPolicy(barcodePolicy, barcodeBlocks);
    barcodePolicyWouldFail = barcodePolicyEval.should_fail;
    if (barcodePolicyWouldFail && barcodePolicyGateMode === 'enforce') {
      const err = new Error(`barcode_quality_gate: ${barcodePolicyEval.fail_reason}`);
      err.code = barcodePolicyEval.fail_reason || 'barcode_policy_violation';
      err.meta = { violations: barcodePolicyEval.violations };
      throw err;
    }
    if (barcodePolicyWouldFail && barcodePolicyGateMode !== 'enforce') {
      barcodePolicyEval = { ...barcodePolicyEval, should_warn: true };
    }
    renderMs = Date.now() - renderStart;
    stage('render_done', { render_ms: renderMs, size_bytes: bytes?.byteLength });
    // Align with complete_label_job path convention <org>/labels/<job>.pdf
    const filePath = `${job.organization_id}/labels/${job.id}.pdf`;
    const file = Buffer.from(bytes);
    stage('upload_start', { file_path: filePath });
    const uploadStart = Date.now();
    const uploadAttemptsRaw = Number(process.env.LABEL_WORKER_UPLOAD_RETRIES);
    const uploadAttempts = Number.isFinite(uploadAttemptsRaw) && uploadAttemptsRaw >= 0 ? Math.floor(uploadAttemptsRaw) + 1 : 4;
    await retry(async () => {
      const { error } = await supabase.storage.from(LABEL_BUCKET).upload(filePath, file, {
        contentType: 'application/pdf',
        upsert: true,
      });
      if (error) throw new Error(`upload failed: ${error.message}`);
    }, { attempts: uploadAttempts, baseDelayMs: 250, label: `upload:${filePath}` });
    uploadMs = Date.now() - uploadStart;
    stage('upload_done', { upload_ms: uploadMs });
    stage('complete_start');
    const totalMsSoFar = Date.now() - t0;
    await completeJobDb(job.id, 'succeeded', filePath, bytes.byteLength, {
      rendered_blocks: snapshot?.renderer_config?.blocks?.length || 0,
      template: { key: templateKey, version: templateVersion },
      settings_resolution: {
        label_render_policy: labelRenderPolicyResolutionId,
        label_print_profile: labelPrintProfileResolutionId,
      },
      timings: {
        compose_ms: composeMs,
        render_ms: renderMs,
        upload_ms: uploadMs,
        total_ms: totalMsSoFar,
      },
      barcode: {
        engine: barcodeEngine,
        engines_used: barcodeEngines,
        policy: {
          gate_mode: barcodePolicyGateMode,
          would_fail: barcodePolicyWouldFail,
          should_warn: barcodePolicyEval.should_warn,
          violations: barcodePolicyEval.violations,
        },
        blocks: barcodeBlocks,
      },
    }, null);
    stage('complete_done');
    const totalMs = Date.now() - t0;
    console.log(JSON.stringify({
      event: 'label_job_render',
      outcome: 'ok',
      job_id: job.id,
      org_id: job.organization_id,
      template_key: templateKey,
      template_version: templateVersion,
      compose_ms: composeMs,
      render_ms: renderMs,
      upload_ms: uploadMs,
      total_ms: totalMs,
      size_bytes: bytes.byteLength
    }));
  } catch (err) {
    stage('error', { error: err?.message || String(err) });
    const totalMs = Date.now() - t0;
    const errCode = err?.code;
    const barcodeReasons = new Set(['barcode_unscannable', 'barcode_at_risk', 'barcode_non_vector', 'barcode_policy_violation']);
    const errorReason = errCode === 'layout_unfit' ? 'layout_unfit' : (barcodeReasons.has(errCode) ? errCode : 'render_failure');
    console.error(JSON.stringify({
      event: 'label_job_render',
      outcome: 'error',
      job_id: job?.id,
      org_id: job?.organization_id,
      compose_ms: composeMs,
      render_ms: renderMs,
      upload_ms: uploadMs,
      total_ms: totalMs,
      error: err?.message || String(err)
    }));
    await completeJobDb(job.id, 'failed', null, null, {
      template: { key: job?.template_key || null, version: job?.template_version || null },
      settings_resolution: {
        label_render_policy: labelRenderPolicyResolutionId,
        label_print_profile: labelPrintProfileResolutionId,
      },
      timings: {
        compose_ms: composeMs,
        render_ms: renderMs,
        upload_ms: uploadMs,
        total_ms: totalMs,
      },
      ...(barcodeBlocks.length ? {
        barcode: {
          engine: barcodeEngine,
          engines_used: barcodeEngines,
          policy: {
            gate_mode: barcodePolicyGateMode,
            would_fail: barcodePolicyWouldFail,
            should_warn: barcodePolicyEval.should_warn,
            violations: barcodePolicyEval.violations,
          },
          blocks: barcodeBlocks,
        },
      } : {}),
      error: {
        reason: errorReason,
        message: err?.message || String(err),
      },
    }, errorReason);
  }
};

const main = async () => {
  emitTraceWithContext(ctx, 'info', {
    event: 'label_worker_start',
    org_id: orgId,
    limit,
    concurrency,
    job_id: onlyJobId,
  });
  await pg.connect();
  await pg.query(`SELECT set_config('request.correlation_id', $1, false)`, [ctx.correlationId]);
  emitTraceWithContext(ctx, 'info', { event: 'label_worker_connected', org_id: orgId });

  try {
    const sharedAssetCache = new Map();
    let attempted = 0;
    while (attempted < limit) {
      const batch = [];
      const slots = Math.min(concurrency, limit - attempted);
      for (let i = 0; i < slots; i += 1) {
        const job = await leaseJobDb();
        if (!job || !job.id) break;
        batch.push(job);
      }
      if (!batch.length) break;
      attempted += batch.length;
      await Promise.all(batch.map((job) => processJob(job, sharedAssetCache)));
    }
    emitTraceWithContext(ctx, 'info', { event: 'label_worker_completed', attempted });
  } finally {
    await pg.end();
  }
};

main().catch((err) => {
  emitTraceWithContext(ctx, 'error', { event: 'label_worker_failed', error_message: err?.message || String(err) });
  process.exit(1);
});
