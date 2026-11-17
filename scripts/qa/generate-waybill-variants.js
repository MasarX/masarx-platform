#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../utils/load-env');
const { overlaps, leftFromAlign, blockBox } = require('../render/layout-sim');
const { hasArabic, toBidiVisualOrder } = require('../render/text-shape');
const { measureBidiVisualWidthWithFallback } = require('../render/text-measure');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const LABEL_BUCKET = process.env.LABEL_RENDER_BUCKET || process.env.LABEL_RENDERER_BUCKET || 'labels';
const ASSET_BUCKET = process.env.LABEL_ASSET_BUCKET || process.env.LABEL_RENDER_ASSETS_BUCKET || 'label-render-assets';

if (!SUPABASE_URL || !SERVICE_KEY || !DATABASE_URL) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL.');
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return fallback;
  return args[idx + 1];
};

const parseIntArg = (name, fallback) => {
  const raw = getArg(name, null);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const progress = getArg('--progress', '1') !== '0';
const workerConcurrencyRaw = Number(getArg('--worker-concurrency', '4'));
const workerConcurrency = Number.isFinite(workerConcurrencyRaw) && workerConcurrencyRaw > 0 ? Math.floor(workerConcurrencyRaw) : 4;
const downloadConcurrency = parseIntArg('--download-concurrency', 8);
const log = (...parts) => {
  if (!progress) return;
  console.log(...parts);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

const nowId = () => {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}-${hh}${mm}${ss}`;
};

const normalizeLangMode = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'ar' || raw === 'arabic') return 'ar';
  if (raw === 'en' || raw === 'english') return 'en';
  return 'mixed';
};

const loadBase64Fixture = (...parts) => {
  const base64Path = path.join(process.cwd(), ...parts);
  const base64 = fs.readFileSync(base64Path, 'utf8');
  return Buffer.from(base64.trim(), 'base64');
};

const makeVariants = (count, runTag, langMode) => {
  const cities = [
    { city: 'Riyadh', province: 'Riyadh', country: 'SA', city_ar: 'الرياض', province_ar: 'الرياض' },
    { city: 'Jeddah', province: 'Makkah', country: 'SA', city_ar: 'جدة', province_ar: 'مكة المكرمة' },
    { city: 'Dammam', province: 'Eastern', country: 'SA', city_ar: 'الدمام', province_ar: 'المنطقة الشرقية' },
    { city: 'Al Khobar', province: 'Eastern', country: 'SA', city_ar: 'الخبر', province_ar: 'المنطقة الشرقية' },
    { city: 'Mecca', province: 'Makkah', country: 'SA', city_ar: 'مكة', province_ar: 'مكة المكرمة' },
    { city: 'Medina', province: 'Medina', country: 'SA', city_ar: 'المدينة', province_ar: 'المدينة المنورة' },
    { city: 'Abha', province: 'Asir', country: 'SA', city_ar: 'أبها', province_ar: 'عسير' },
    { city: 'Tabuk', province: 'Tabuk', country: 'SA', city_ar: 'تبوك', province_ar: 'تبوك' },
    { city: 'Hail', province: 'Hail', country: 'SA', city_ar: 'حائل', province_ar: 'حائل' },
    { city: 'Najran', province: 'Najran', country: 'SA', city_ar: 'نجران', province_ar: 'نجران' },
    { city: 'Taif', province: 'Makkah', country: 'SA', city_ar: 'الطائف', province_ar: 'مكة المكرمة' },
    { city: 'Yanbu', province: 'Medina', country: 'SA', city_ar: 'ينبع', province_ar: 'المدينة المنورة' },
  ];

  const serviceTypes = ['delivery', 'pickup', 'swap', 'rto'];
  const langs = langMode === 'ar' ? ['ar'] : (langMode === 'en' ? ['en'] : ['en', 'ar']);

  const repeatWords = (base, words) => (
    Array.from({ length: words }).map(() => base).join(' ')
  );

  const repeatArabic = (base, words) => (
    Array.from({ length: words }).map(() => base).join(' ')
  );

  const longDigits = (n) => Array.from({ length: n }).map((_, i) => ((i * 7) % 10)).join('');

  const arabicNames = [
    'جوجو',
    'محمد',
    'عبدالله',
    'سارة',
    'فاطمة',
    'خالد',
    'نورة',
    'فيصل',
    'ريم',
    'يوسف',
  ];

  const variants = [];
  for (let i = 0; i < count; i += 1) {
    const idx = i + 1;
    const city = cities[i % cities.length];
    const originCity = cities[(i + 3) % cities.length];
    const serviceType = serviceTypes[i % serviceTypes.length];
    const preferredLanguage = langs[i % langs.length];
    const useArabic = preferredLanguage === 'ar';

    const tag = String(runTag || 'X').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'X';
    const trackingCore = `MSX${tag}${String(idx).padStart(2, '0')}${longDigits(12 + (i % 40))}`;
    const trackingNumber = trackingCore.slice(0, 60);

    const refChoice = i % 3;
    const refSeedLen = 18 + (i % 15); // 18..32 (fits reference_number field under hard-min font sizes)
    const refSeed = trackingCore.slice(0, refSeedLen);
    const clientRef = refChoice === 0 ? `REF-${refSeed}` : null;
    const carrierRef = refChoice === 1 ? `CRR-${refSeed}-${longDigits(2 + (i % 4))}` : null;

    const codAmount = i % 4 === 0 ? null : (i % 4 === 1 ? 0 : (i % 4 === 2 ? 25.75 : 99999.99));
    const codCurrency = i % 5 === 0 ? 'SAR' : (i % 5 === 1 ? 'AED' : 'SAR');

    const recipientNameBase = i % 5 === 0 ? 'J' : 'Recipient';
    const recipientName = useArabic
      ? `${arabicNames[i % arabicNames.length]} ${repeatArabic('اسمطويلجداً', i % 7)} ${idx}`.trim()
      : `${recipientNameBase} ${repeatWords('VeryLongName', i % 7)} ${idx}`.trim();
    const recipientPhone = i % 6 === 0
      ? `+966${longDigits(9 + (i % 8))}`
      : `00${longDigits(10 + (i % 12))}`;

    const senderName = useArabic
      ? `المرسل ${repeatArabic('متجر', 1 + (i % 4))} ${idx}`.trim()
      : `Sender ${repeatWords('Store', 1 + (i % 4))} ${idx}`.trim();
    const senderPhone = i % 5 === 0
      ? `+966${longDigits(9 + (i % 10))}`
      : `00${longDigits(10 + (i % 14))}`;

    const headerBrandMode = (i % 3 === 0) ? 'text' : 'logo';
    const senderBrandName = headerBrandMode === 'text'
      ? (
        useArabic
          ? `شركة ${repeatArabic('ديليكس', 2 + (i % 7))} ${idx}`.trim()
          : `Company ${repeatWords('VeryLongBrand', 2 + (i % 7))} ${idx}`.trim()
      )
      : 'MasarX';

    const originLine1 = useArabic
      ? `مستودع-${idx} ${repeatArabic('طريق الملك فهد', 1 + (i % 5))}`.trim()
      : `WH-${idx} ${repeatWords('Warehouse Road', 1 + (i % 5))}`.trim();
    const destLine1 = useArabic
      ? `${idx} ${repeatArabic('شارع الملك فهد', 1 + (i % 6))}`.trim()
      : `${idx} ${repeatWords('King Fahd Rd', 1 + (i % 6))}`.trim();

    const notes = useArabic
      ? (
        (i % 4 === 0)
          ? `هش: ${repeatArabic('يرجى التعامل بحذر', 2 + (i % 4))}`
          : (i % 4 === 1)
            ? `قائمة الأصناف: ${repeatArabic('صنف-١٢٣٤٥', 3 + (i % 5))}`
            : (i % 4 === 2)
              ? `ملاحظات: ${repeatArabic('يرجى التوصيل بين 9-5', 3 + (i % 4))}`
              : `محتوى: ${repeatArabic('عناصر متنوعة', 4 + (i % 6))}`
      )
      : (
        (i % 4 === 0)
          ? `Fragile ${repeatWords('Handle with care', 12 + (i % 14))}`
          : (i % 4 === 1)
            ? `Item list: ${repeatWords('SKU-12345', 20 + (i % 20))}`
            : (i % 4 === 2)
              ? `Notes ${repeatWords('Please deliver between 9-5', 14 + (i % 10))}`
              : `Content ${repeatWords('Mixed items', 24 + (i % 16))}`
      );

    const weightKg = i % 3 === 0 ? Number((0.25 + (i % 7) * 1.75).toFixed(2)) : null;
    const volWeight = weightKg == null ? Number((1.5 + (i % 9) * 0.9).toFixed(2)) : null;

    variants.push({
      idx,
      serviceType,
      preferredLanguage,
      trackingNumber,
      boxNumber: 1 + (i % 3),
      barcode: `${trackingNumber}:${1 + (i % 3)}`,
      clientReferenceNumber: clientRef,
      carrierReferenceNumber: carrierRef,
      codAmount,
      codCurrency,
      senderName,
      senderBrandName,
      recipientName,
      recipientPhone,
      origin: {
        line1: originLine1,
        city: useArabic ? originCity.city_ar : originCity.city,
        province: useArabic ? originCity.province_ar : originCity.province,
        country: originCity.country,
      },
      destination: {
        line1: destLine1,
        city: useArabic ? city.city_ar : city.city,
        province: useArabic ? city.province_ar : city.province,
        country: city.country,
      },
      box: {
        weightKg,
        volumetricWeightKg: volWeight,
        lengthCm: 10 + (i % 40),
        widthCm: 10 + ((i * 2) % 40),
        heightCm: 5 + ((i * 3) % 30),
        fragile: i % 7 === 0,
        hazmat: i % 11 === 0,
      },
      metadata: {
        notes,
        variant: idx,
        preferred_language: preferredLanguage,
        sender_phone: senderPhone,
        header_brand_mode: headerBrandMode,
      },
    });
  }

  return variants;
};

const main = async () => {
  const count = Number(getArg('--count', '30'));
  const langMode = normalizeLangMode(getArg('--lang', 'mixed'));
  const outDir = path.resolve(process.cwd(), getArg('--out-dir', path.join('tmp', `waybill-variants-${nowId()}`)));
  const compiledPath = path.resolve(process.cwd(), getArg('--compiled', path.join('tmp', 'waybill.v1.8.5.compiled.json')));
  const keepFiles = getArg('--keep', '0') === '1';

  if (!Number.isFinite(count) || count <= 0) {
    console.error('Invalid --count');
    process.exit(1);
  }
  if (!fs.existsSync(compiledPath)) {
    console.error(`Missing compiled template file: ${compiledPath}`);
    process.exit(1);
  }

  log(JSON.stringify({ event: 'waybill_variants_start', count, langMode, outDir, compiledPath, keepFiles, workerConcurrency, downloadConcurrency }));

  const compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
  const sectionsByKey = new Map((compiled.sections || []).map((s) => [s.section_key, s]));

  ensureDir(outDir);
  if (keepFiles) ensureDir(path.join(outDir, 'labels'));

  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const workerEnv = process.env.ENV_FILE
    ? { ...process.env, ENV_FILE: process.env.ENV_FILE }
    : { ...process.env };
  const pdfDoc = await PDFDocument.create();
  const fonts = {
    normal: await pdfDoc.embedFont(StandardFonts.Helvetica),
    bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    courier: await pdfDoc.embedFont(StandardFonts.Courier),
    times: await pdfDoc.embedFont(StandardFonts.TimesRoman),
  };

  const orgId = randomUUID();
  const clientId = randomUUID();

  const runTag = orgId.replace(/-/g, '').slice(0, 6);
  const variants = makeVariants(count, runTag, langMode);
  const needsArabic = variants.some((v) => v.preferredLanguage === 'ar');
  const jobIds = [];
  const index = [];
  const timers = { started_at: new Date().toISOString() };
  const t0 = Date.now();

  try {
    const seedStart = Date.now();
    await pg.query('BEGIN');
    try {
      await pg.query(
        `INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
         VALUES ($1::uuid, 'Waybill Variants Org', $2::text, 'Asia/Riyadh', 'en-US', 'active')`,
        [orgId, `waybill-variants-${orgId.slice(0, 8)}`]
      );

      await pg.query(
        `INSERT INTO clients (id, organization_id, name, slug, sla_tier, status, settings_override)
         VALUES ($1::uuid, $2::uuid, 'Waybill Variants Client', $3::text, 'standard', 'active', '{}'::jsonb)`,
        [clientId, orgId, `waybill-variants-client-${clientId.slice(0, 8)}`]
      );
    } catch (err) {
      await pg.query('ROLLBACK');
      throw err;
    }
    await pg.query('COMMIT');

    let arabicFonts = null;
    if (needsArabic && (!process.env.LABEL_ARABIC_FONT_REGULAR_PATH || !process.env.LABEL_ARABIC_FONT_BOLD_PATH)) { throw new Error('Arabic variant generation requires externally supplied licensed font files.'); }
    if (needsArabic) {
      log(JSON.stringify({ event: 'waybill_variants_arabic_setup_start', orgId, asset_bucket: ASSET_BUCKET }));
      const regularBytes = fs.readFileSync(process.env.LABEL_ARABIC_FONT_REGULAR_PATH);
      const boldBytes = fs.readFileSync(process.env.LABEL_ARABIC_FONT_BOLD_PATH);
      const fontRegularKey = `${orgId}/fonts/NotoNaskhArabic-Regular.ttf`;
      const fontBoldKey = `${orgId}/fonts/NotoNaskhArabic-Bold.ttf`;

      const { error: fontErrA } = await supabase.storage
        .from(ASSET_BUCKET)
        .upload(fontRegularKey, regularBytes, { contentType: 'font/ttf', upsert: true });
      if (fontErrA) throw new Error(`font upload failed: ${fontErrA.message}`);

      const { error: fontErrB } = await supabase.storage
        .from(ASSET_BUCKET)
        .upload(fontBoldKey, boldBytes, { contentType: 'font/ttf', upsert: true });
      if (fontErrB) throw new Error(`font upload failed: ${fontErrB.message}`);

      const policyVersionId = randomUUID();
      const tenantPolicyValue = {
        version: 1,
        header_brand_mode: 'logo',
        text_defaults: {
          font_regular: 'Helvetica',
          font_bold: 'Helvetica-Bold',
          min_font_size: 6,
          hard_min_font_size: 2,
          line_height_factor: 1.0,
          overflow: 'shrink',
        },
        metrics: { window_minutes: 60, min_samples: 25, slo_p95_render_ms: 4000, slo_p95_total_ms: 8000 },
        arabic: { enabled: true, direction: 'auto', font_asset_regular: fontRegularKey, font_asset_bold: fontBoldKey },
      };

      await pg.query('BEGIN');
      try {
        await pg.query(
          `INSERT INTO settings_versions (
             id, category, scope_type, scope_id, scope_hash,
             version, value, schema_version, change_reason, approved_at, effective_from, effective_until
           )
           VALUES (
             $1::uuid, 'label_render_policy', 'tenant', $2::uuid, $2::uuid,
             1, $3::jsonb, 1, 'waybill variants: enable arabic', now(), now(), NULL
           )`,
          [policyVersionId, orgId, JSON.stringify(tenantPolicyValue)]
        );

        await pg.query(
          `INSERT INTO settings (
             id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated
           )
           VALUES (
             $1::uuid, 'label_render_policy', 'tenant', $2::uuid, $2::uuid, $3::uuid, $4::jsonb, now()
           )
           ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
           SET settings_version_id = EXCLUDED.settings_version_id,
               cached_value = EXCLUDED.cached_value,
               last_updated = EXCLUDED.last_updated`,
          [randomUUID(), orgId, policyVersionId, JSON.stringify(tenantPolicyValue)]
        );
      } catch (err) {
        await pg.query('ROLLBACK');
        throw err;
      }
      await pg.query('COMMIT');

      pdfDoc.registerFontkit(fontkit);
      arabicFonts = {
        regular: await pdfDoc.embedFont(regularBytes, { subset: true }),
        bold: await pdfDoc.embedFont(boldBytes, { subset: true }),
        keys: { regular: fontRegularKey, bold: fontBoldKey },
      };

      log(JSON.stringify({ event: 'waybill_variants_arabic_setup_done', font_regular: fontRegularKey, font_bold: fontBoldKey }));
    }

    const senderIds = [];
    const senderNames = [];
    const senderBrandNames = [];

    const recipientIds = [];
    const recipientNames = [];
    const recipientPhones = [];
    const recipientLangs = [];

    const addressIds = [];
    const addressRawInputs = [];
    const addressNormalizedLine1s = [];
    const addressCities = [];
    const addressProvinces = [];
    const addressCountries = [];

    const shipmentIds = [];
    const shipmentSenderIds = [];
    const shipmentServiceTypes = [];
    const shipmentTrackingNumbers = [];
    const shipmentRecipientIds = [];
    const shipmentOriginAddressIds = [];
    const shipmentDestAddressIds = [];
    const shipmentCodAmounts = [];
    const shipmentCodCurrencies = [];
    const shipmentClientRefNumbers = [];
    const shipmentCarrierRefNumbers = [];
    const shipmentMetadataTexts = [];

    const boxIds = [];
    const boxShipmentIds = [];
    const boxNumbers = [];
    const boxBarcodes = [];
    const boxWeightKgs = [];
    const boxVolumetricWeightKgs = [];
    const boxLengthCms = [];
    const boxWidthCms = [];
    const boxHeightCms = [];
    const boxFragiles = [];
    const boxHazmats = [];

    for (const v of variants) {
      const senderId = randomUUID();
      const recipientId = randomUUID();
      const originAddressId = randomUUID();
      const destAddressId = randomUUID();
      const shipmentId = randomUUID();
      const boxId = randomUUID();

      senderIds.push(senderId);
      senderNames.push(v.senderName);
      senderBrandNames.push(v.senderBrandName);

      recipientIds.push(recipientId);
      recipientNames.push(v.recipientName);
      recipientPhones.push(v.recipientPhone);
      recipientLangs.push(v.preferredLanguage);

      addressIds.push(originAddressId);
      addressRawInputs.push(v.origin.line1);
      addressNormalizedLine1s.push(v.origin.line1);
      addressCities.push(v.origin.city);
      addressProvinces.push(v.origin.province);
      addressCountries.push(v.origin.country);

      addressIds.push(destAddressId);
      addressRawInputs.push(v.destination.line1);
      addressNormalizedLine1s.push(v.destination.line1);
      addressCities.push(v.destination.city);
      addressProvinces.push(v.destination.province);
      addressCountries.push(v.destination.country);

      shipmentIds.push(shipmentId);
      shipmentSenderIds.push(senderId);
      shipmentServiceTypes.push(v.serviceType);
      shipmentTrackingNumbers.push(v.trackingNumber);
      shipmentRecipientIds.push(recipientId);
      shipmentOriginAddressIds.push(originAddressId);
      shipmentDestAddressIds.push(destAddressId);
      shipmentCodAmounts.push(v.codAmount == null ? null : Number(v.codAmount));
      shipmentCodCurrencies.push(v.codCurrency);
      shipmentClientRefNumbers.push(v.clientReferenceNumber);
      shipmentCarrierRefNumbers.push(v.carrierReferenceNumber);
      shipmentMetadataTexts.push(JSON.stringify(v.metadata || {}));

      boxIds.push(boxId);
      boxShipmentIds.push(shipmentId);
      boxNumbers.push(v.boxNumber);
      boxBarcodes.push(v.barcode);
      boxWeightKgs.push(v.box.weightKg == null ? null : Number(v.box.weightKg));
      boxVolumetricWeightKgs.push(v.box.volumetricWeightKg == null ? null : Number(v.box.volumetricWeightKg));
      boxLengthCms.push(v.box.lengthCm);
      boxWidthCms.push(v.box.widthCm);
      boxHeightCms.push(v.box.heightCm);
      boxFragiles.push(Boolean(v.box.fragile));
      boxHazmats.push(Boolean(v.box.hazmat));

      if (v.idx % 10 === 0) {
        log(JSON.stringify({ event: 'waybill_variants_seed_progress', prepared: v.idx, total: variants.length }));
      }
    }

    await pg.query('BEGIN');
    try {
      await pg.query(
        `INSERT INTO senders (id, client_id, name, brand_name, status, created_at, updated_at)
         SELECT t.id, $2::uuid, t.name, t.brand_name, 'active', now(), now()
         FROM UNNEST($1::uuid[], $3::text[], $4::text[]) AS t(id, name, brand_name)`,
        [senderIds, clientId, senderNames, senderBrandNames]
      );

      await pg.query(
        `INSERT INTO recipients (id, organization_id, client_id, name, phone_number, preferred_language, created_at, updated_at)
         SELECT t.id, $2::uuid, $3::uuid, t.name, t.phone_number, t.preferred_language, now(), now()
         FROM UNNEST($1::uuid[], $4::text[], $5::text[], $6::text[]) AS t(id, name, phone_number, preferred_language)`,
        [recipientIds, orgId, clientId, recipientNames, recipientPhones, recipientLangs]
      );

      await pg.query(
        `INSERT INTO addresses (
           id, organization_id, client_id, raw_input, normalized_line1, normalized_line2,
           district, city, province, postal_code, country, validation_status, created_at, updated_at
         )
         SELECT t.id, $2::uuid, $3::uuid, t.raw_input, t.normalized_line1, NULL,
                NULL, t.city, t.province, NULL, t.country, 'pending', now(), now()
         FROM UNNEST($1::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS t(
           id, raw_input, normalized_line1, city, province, country
         )`,
        [addressIds, orgId, clientId, addressRawInputs, addressNormalizedLine1s, addressCities, addressProvinces, addressCountries]
      );

      await pg.query(
        `INSERT INTO shipments (
           id, organization_id, client_id, sender_id, service_type, tracking_number, status, box_count,
           recipient_id, origin_address_id, destination_address_id,
           cod_amount, cod_currency,
           client_reference_number, carrier_reference_number,
           metadata, created_at, updated_at
         )
         SELECT
           t.id, $2::uuid, $3::uuid, t.sender_id, t.service_type, t.tracking_number, 'pending', 1,
           t.recipient_id, t.origin_address_id, t.destination_address_id,
           t.cod_amount, t.cod_currency,
           t.client_reference_number, t.carrier_reference_number,
           t.metadata_text::jsonb, now(), now()
         FROM UNNEST(
           $1::uuid[],
           $4::uuid[],
           $5::text[],
           $6::text[],
           $7::uuid[],
           $8::uuid[],
           $9::uuid[],
           $10::numeric[],
           $11::text[],
           $12::text[],
           $13::text[],
           $14::text[]
         ) AS t(
           id, sender_id, service_type, tracking_number,
           recipient_id, origin_address_id, destination_address_id,
           cod_amount, cod_currency,
           client_reference_number, carrier_reference_number,
           metadata_text
         )`,
        [
          shipmentIds,
          orgId,
          clientId,
          shipmentSenderIds,
          shipmentServiceTypes,
          shipmentTrackingNumbers,
          shipmentRecipientIds,
          shipmentOriginAddressIds,
          shipmentDestAddressIds,
          shipmentCodAmounts,
          shipmentCodCurrencies,
          shipmentClientRefNumbers,
          shipmentCarrierRefNumbers,
          shipmentMetadataTexts,
        ]
      );

      await pg.query(
        `INSERT INTO shipment_boxes (
           id, shipment_id, organization_id, client_id, box_number, barcode, created_at,
           weight_kg, volumetric_weight_kg, length_cm, width_cm, height_cm, fragile, hazmat
         )
         SELECT
           t.id, t.shipment_id, $2::uuid, $3::uuid, t.box_number, t.barcode, now(),
           t.weight_kg, t.volumetric_weight_kg, t.length_cm, t.width_cm, t.height_cm, t.fragile, t.hazmat
         FROM UNNEST(
           $1::uuid[],
           $4::uuid[],
           $5::int[],
           $6::text[],
           $7::numeric[],
           $8::numeric[],
           $9::int[],
           $10::int[],
           $11::int[],
           $12::boolean[],
           $13::boolean[]
         ) AS t(
           id, shipment_id,
           box_number, barcode,
           weight_kg, volumetric_weight_kg,
           length_cm, width_cm, height_cm,
           fragile, hazmat
         )`,
        [
          boxIds,
          orgId,
          clientId,
          boxShipmentIds,
          boxNumbers,
          boxBarcodes,
          boxWeightKgs,
          boxVolumetricWeightKgs,
          boxLengthCms,
          boxWidthCms,
          boxHeightCms,
          boxFragiles,
          boxHazmats,
        ]
      );

      const { rows } = await pg.query(
        `SELECT
           t.ord::int AS ord,
           request_label_generation(t.shipment_id, 'shipping', NULL, 'waybill_variants', t.box_id, 'primary') AS job_id
         FROM UNNEST($1::uuid[], $2::uuid[]) WITH ORDINALITY AS t(shipment_id, box_id, ord)
         ORDER BY t.ord`,
        [shipmentIds, boxIds]
      );

      for (const row of rows) {
        const idx = row.ord;
        const v = variants[idx - 1];
        const jobId = row.job_id;
        jobIds.push(jobId);
        index.push({
          idx: v.idx,
          jobId,
          trackingNumber: v.trackingNumber,
          serviceType: v.serviceType,
          codAmount: v.codAmount,
          codCurrency: v.codCurrency,
          senderPhone: v.metadata?.sender_phone || null,
          senderBrandName: v.senderBrandName,
          headerBrandMode: v.metadata?.header_brand_mode || null,
          recipientName: v.recipientName,
          recipientPhone: v.recipientPhone,
          destinationCity: v.destination.city,
          referenceNumber: v.clientReferenceNumber || v.carrierReferenceNumber || v.trackingNumber,
          notesLength: (v.metadata?.notes || '').length,
        });
      }
    } catch (err) {
      await pg.query('ROLLBACK');
      throw err;
    }
    await pg.query('COMMIT');

    timers.seed_ms = Date.now() - seedStart;

    log(JSON.stringify({ event: 'waybill_variants_render_start', jobs: jobIds.length }));
    const renderStart = Date.now();
    const worker = spawnSync('node', [
      'scripts/workers/render-label-jobs.js',
      '--org-id', orgId,
      '--limit', String(jobIds.length + 5),
      '--concurrency', String(workerConcurrency),
    ], {
      env: workerEnv,
      encoding: 'utf8',
      stdio: progress ? 'inherit' : 'pipe',
    });
    if (worker.status !== 0) {
      throw new Error(`worker failed: ${worker.stderr || worker.stdout}`);
    }

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const { rows } = await pg.query(
        `SELECT id, status, output_file_url, error_reason
         FROM label_jobs
         WHERE id = ANY($1::uuid[])`,
        [jobIds]
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const failed = jobIds
        .map((id) => byId.get(id))
        .filter((row) => row && row.status === 'failed');
      if (failed.length) {
        const sample = failed.slice(0, 5).map((r) => `${r.id}:${r.error_reason || 'unknown'}`).join(', ');
        throw new Error(`Label render failed for ${failed.length}/${jobIds.length} jobs: ${sample}${failed.length > 5 ? '…' : ''}`);
      }
      const pending = jobIds.filter((id) => {
        const row = byId.get(id);
        return !row || row.status !== 'succeeded' || !row.output_file_url;
      });
      if (pending.length === 0) break;

      log(JSON.stringify({ event: 'waybill_variants_render_pending', pending: pending.length }));
      spawnSync('node', [
        'scripts/workers/render-label-jobs.js',
        '--org-id', orgId,
        '--limit', String(Math.min(10, pending.length)),
        '--concurrency', String(workerConcurrency),
      ], {
        env: workerEnv,
        encoding: 'utf8',
        stdio: progress ? 'inherit' : 'pipe',
      });
      await sleep(1500);
    }

    timers.render_ms = Date.now() - renderStart;

    const { rows: jobRows } = await pg.query(
      `SELECT id, status, output_file_url, template_snapshot
       FROM label_jobs
       WHERE id = ANY($1::uuid[])`,
      [jobIds]
    );
    const jobById = new Map(jobRows.map((r) => [r.id, r]));
    const notDone = jobIds.filter((id) => jobById.get(id)?.status !== 'succeeded' || !jobById.get(id)?.output_file_url);
    if (notDone.length) {
      throw new Error(`Some jobs did not complete: ${notDone.slice(0, 5).join(', ')}${notDone.length > 5 ? '…' : ''}`);
    }

    const validateStart = Date.now();
    log(JSON.stringify({ event: 'waybill_variants_validate_start', jobs: jobIds.length }));
    const layoutIssues = [];
    for (const jobId of jobIds) {
      const { rows } = await pg.query('select compose_label_payload($1) as c', [jobId]);
      const payload = rows[0].c.payload || {};
      const rendererConfig = rows[0].c.job?.template?.renderer_config || {};
      const policy = payload && typeof payload === 'object' ? payload.label_render_policy : null;
      const textDefaults = policy && typeof policy === 'object' ? policy.text_defaults : null;
      const policyArabic = policy && typeof policy === 'object' ? policy.arabic : null;
      const arabicEnabled = !!(policyArabic && typeof policyArabic === 'object' && policyArabic.enabled === true);
      const arabicDirection = policyArabic && typeof policyArabic === 'object' ? policyArabic.direction : null;
      const issues = (() => {
        const ctx = {
          pageW: (rendererConfig?.page?.width_inch || 4) * 72,
          fonts,
          selectFont: (() => {
            const cache = new Map();
            return (name) => {
              const n = (name || 'helvetica').toLowerCase();
              if (cache.has(n)) return cache.get(n);
              switch (n) {
                case 'helvetica-bold':
                case 'helvetica_bold':
                case 'bold':
                  cache.set(n, fonts.bold);
                  break;
                case 'courier':
                case 'barcode':
                  cache.set(n, fonts.courier);
                  break;
                case 'times':
                case 'times-roman':
                  cache.set(n, fonts.times);
                  break;
                default:
                  cache.set(n, fonts.normal);
                  break;
              }
              return cache.get(n);
            };
          })(),
          selectTextFont: (fontName, rawText) => {
            if (!arabicEnabled || !arabicFonts || !hasArabic(rawText)) return null;
            const isBold = /bold/i.test(String(fontName || '')) || String(fontName || '').toLowerCase() === 'bold';
            return isBold ? arabicFonts.bold : arabicFonts.regular;
          },
          getTextForFit: (rawText) => (
            arabicEnabled && hasArabic(rawText) ? toBidiVisualOrder(rawText, arabicDirection) : rawText
          ),
          textDefaults,
          measureTextWidthWithFallback: measureBidiVisualWidthWithFallback,
        };
        const page = rendererConfig?.page || {};
        const pageW = (page.width_inch || 4) * 72;
        const pageH = (page.height_inch || 6) * 72;
        const strictSections = new Set(['bottom_table', 'refs_cod']);
        const issues = [];
        const boxes = [];
        for (const block of rendererConfig?.blocks || []) {
          const box = blockBox(payload, block, { ...ctx, pageW, pageH });
          if (!box) continue;
          if (box.unfit) {
            issues.push({ type: 'text_unfit', block: box.blockLabel, section_key: box.section_key, box });
          }
          if (box.x < 0 || box.y < 0 || box.x + box.width > pageW || box.y + box.height > pageH) {
            issues.push({ type: 'out_of_bounds', block: box.blockLabel, box });
          }
          if (box.section_key && sectionsByKey && sectionsByKey.has(box.section_key)) {
            const s = sectionsByKey.get(box.section_key);
            const sx = Number(s.x);
            const sy = Number(s.y);
            const sw = Number(s.width);
            const sh = Number(s.height);
            const within = (
              box.x >= sx - 0.01 &&
              box.y >= sy - 0.01 &&
              box.x + box.width <= sx + sw + 0.01 &&
              box.y + box.height <= sy + sh + 0.01
            );
            if (!within) {
              issues.push({ type: 'out_of_section', block: box.blockLabel, section_key: box.section_key, box, section: s });
            }
          }
          if (
            box.section_key &&
            strictSections.has(box.section_key) &&
            typeof block.width === 'number' &&
            typeof block.height === 'number' &&
            block.width > 0 &&
            block.height > 0
          ) {
            const cx = leftFromAlign(block, block.width);
            const cy = typeof block.y === 'number' ? block.y : 0;
            const withinField = (
              box.x >= cx - 0.01 &&
              box.y >= cy - 0.01 &&
              box.x + box.width <= cx + block.width + 0.01 &&
              box.y + box.height <= cy + block.height + 0.01
            );
            if (!withinField) {
              issues.push({ type: 'out_of_field', block: box.blockLabel, section_key: box.section_key, box, field: { x: cx, y: cy, width: block.width, height: block.height } });
            }
          }
          for (const existing of boxes) {
            if (overlaps(existing, box)) {
              issues.push({ type: 'overlap', a: existing.blockLabel, b: box.blockLabel, aBox: existing, bBox: box });
            }
          }
          boxes.push(box);
        }
        return issues;
      })();
      if (issues.length) {
        layoutIssues.push({ jobId, issues });
      }
    }
    if (layoutIssues.length) {
      const reportPath = path.join(outDir, 'layout-issues.json');
      fs.writeFileSync(reportPath, JSON.stringify(layoutIssues, null, 2) + '\n', 'utf8');
      throw new Error(`Layout validation failed for ${layoutIssues.length}/${jobIds.length} labels. See ${reportPath}`);
    }

    timers.validate_ms = Date.now() - validateStart;

    log(JSON.stringify({ event: 'waybill_variants_bundle_start', jobs: jobIds.length }));
    const { rows: outRows } = await pg.query(
      `SELECT id, output_file_url FROM label_jobs WHERE id = ANY($1::uuid[])`,
      [jobIds]
    );
    const outById = new Map(outRows.map((r) => [r.id, r.output_file_url]));
    for (const entry of index) {
      entry.storageKey = outById.get(entry.jobId);
    }

    const downloadLabelsStart = Date.now();
    if (keepFiles) {
      const mapWithConcurrency = async (items, limit, fn) => {
        const results = new Array(items.length);
        let next = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }).map(async () => {
          while (true) {
            const idx = next;
            next += 1;
            if (idx >= items.length) break;
            results[idx] = await fn(items[idx], idx);
          }
        });
        await Promise.all(workers);
        return results;
      };

      await mapWithConcurrency(index, downloadConcurrency, async (entry) => {
        const fileKey = entry.storageKey;
        const { data, error } = await supabase.storage.from(LABEL_BUCKET).download(fileKey);
        if (error) throw new Error(`download failed: ${fileKey}: ${error.message}`);
        const bytes = new Uint8Array(await data.arrayBuffer());
        const outPath = path.join(outDir, 'labels', `${String(entry.idx).padStart(3, '0')}-${entry.jobId}.pdf`);
        fs.writeFileSync(outPath, Buffer.from(bytes));
        entry.localPath = outPath;
      });
    }
    timers.label_download_ms = Date.now() - downloadLabelsStart;

    const jobIdsFile = path.join(outDir, 'job_ids.txt');
    fs.writeFileSync(jobIdsFile, `${jobIds.join(',')}\n`, 'utf8');

    const bundleKey = `${orgId}/bundles/waybill-variants-${nowId()}.pdf`;
    const mergeStart = Date.now();
    const merge = spawnSync('node', [
      'scripts/workers/run-bundle-merge.js',
      '--job-file', jobIdsFile,
      '--output', bundleKey,
      '--download-concurrency', String(downloadConcurrency),
      '--record',
    ], {
      env: workerEnv,
      encoding: 'utf8',
    });
    if (merge.status !== 0) {
      throw new Error(`bundle merge failed: ${merge.stderr || merge.stdout}`);
    }
    timers.merge_ms = Date.now() - mergeStart;

    const signStart = Date.now();
    const { data: bundleSigned, error: signedErr } = await supabase.storage.from(LABEL_BUCKET).createSignedUrl(bundleKey, 60 * 60);
    if (signedErr) throw new Error(`bundle signed url failed: ${signedErr.message}`);
    timers.bundle_sign_ms = Date.now() - signStart;

    const dlStart = Date.now();
    const { data: bundleData, error: bundleDlErr } = await supabase.storage.from(LABEL_BUCKET).download(bundleKey);
    if (bundleDlErr) throw new Error(`bundle download failed: ${bundleDlErr.message}`);
    const bundleBytes = new Uint8Array(await bundleData.arrayBuffer());
    const bundleLocal = path.join(outDir, 'bundle.pdf');
    fs.writeFileSync(bundleLocal, Buffer.from(bundleBytes));
    timers.bundle_download_ms = Date.now() - dlStart;
    timers.total_ms = Date.now() - t0;

    const summary = {
      status: 'ok',
      orgId,
      clientId,
      templateVersion: compiled.renderer_config?.version,
      templateKey: compiled.template_key,
      count: jobIds.length,
      outDir,
      bundleKey,
      bundleLocal,
      bundleSignedUrl: bundleSigned.signedUrl,
      jobIdsFile,
      index,
      timings: timers,
    };
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pg.end();
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
