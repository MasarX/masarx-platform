#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const STORAGE_ADMIN_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;
const ASSET_BUCKET = process.env.LABEL_ASSET_BUCKET || process.env.LABEL_RENDER_ASSETS_BUCKET || 'label-render-assets';

if (!SUPABASE_URL || !STORAGE_ADMIN_KEY) {
  console.error('Missing SUPABASE_URL or storage admin key (SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const exact = args.find((a) => a === name || a.startsWith(`${name}=`));
  if (!exact) return fallback;
  if (exact.includes('=')) return exact.slice(exact.indexOf('=') + 1);
  const idx = args.indexOf(name);
  if (idx === -1 || idx === args.length - 1) return fallback;
  return args[idx + 1];
};

const upsert = getArg('--upsert', '1') !== '0';
const skipArabic = getArg('--skip-arabic-fonts', '1') === '1';
const skipFileAssets = getArg('--skip-file-assets', '0') === '1';
const assetsRootDefault = process.env.LABEL_ASSETS_ROOT || path.join('assets', 'label-render-assets');
const assetsRoot = path.resolve(process.cwd(), String(getArg('--assets-root', assetsRootDefault) || ''));
const shouldLogJson = () => {
  const explicit = getArg('--json', '');
  if (explicit) return explicit !== '0';
  return /^(1|true|yes)$/i.test(String(process.env.PITCH_LOG_JSON || '').trim());
};

const defaultRegularKey = process.env.LABEL_ARABIC_FONT_REGULAR_KEY || 'fonts/noto-naskh-arabic-regular.ttf';
const defaultBoldKey = process.env.LABEL_ARABIC_FONT_BOLD_KEY || 'fonts/noto-naskh-arabic-bold.ttf';
const defaultRegularBase64 = process.env.LABEL_ARABIC_FONT_REGULAR_BASE64 || '';
const defaultBoldBase64 = process.env.LABEL_ARABIC_FONT_BOLD_BASE64 || '';

const arabicFontRegularKey = String(getArg('--arabic-font-regular-key', defaultRegularKey) || '').trim();
const arabicFontBoldKey = String(getArg('--arabic-font-bold-key', defaultBoldKey) || '').trim();
const arabicFontRegularBase64Path = path.resolve(process.cwd(), String(getArg('--arabic-font-regular-base64', defaultRegularBase64) || ''));
const arabicFontBoldBase64Path = path.resolve(process.cwd(), String(getArg('--arabic-font-bold-base64', defaultBoldBase64) || ''));

const loadBase64File = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  const base64 = raw.trim();
  return Buffer.from(base64, 'base64');
};

const guessContentType = (key) => {
  const ext = path.extname(key || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.ttf') return 'font/ttf';
  if (ext === '.otf') return 'font/otf';
  if (ext === '.json') return 'application/json';
  if (ext === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
};

const listFilesRecursive = (dir) => {
  const out = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
};

async function main() {
  const supabase = createClient(SUPABASE_URL, STORAGE_ADMIN_KEY, { auth: { persistSession: false } });
  const uploads = [];

  if (!skipArabic) {
    if (!arabicFontRegularKey || !arabicFontBoldKey) {
      throw new Error('Arabic font keys are required (arabic.enabled depends on these paths).');
    }
    if (!fs.existsSync(arabicFontRegularBase64Path)) {
      throw new Error(`Missing Arabic font fixture: ${arabicFontRegularBase64Path}`);
    }
    if (!fs.existsSync(arabicFontBoldBase64Path)) {
      throw new Error(`Missing Arabic font fixture: ${arabicFontBoldBase64Path}`);
    }

    uploads.push({
      key: arabicFontRegularKey,
      bytes: loadBase64File(arabicFontRegularBase64Path),
      contentType: 'font/ttf',
      label: 'arabic_font_regular',
    });
    uploads.push({
      key: arabicFontBoldKey,
      bytes: loadBase64File(arabicFontBoldBase64Path),
      contentType: 'font/ttf',
      label: 'arabic_font_bold',
    });
  }

  if (!skipFileAssets && fs.existsSync(assetsRoot)) {
    const files = listFilesRecursive(assetsRoot);
    for (const filePath of files) {
      const rel = path.relative(assetsRoot, filePath);
      if (!rel) continue;
      const key = rel.split(path.sep).join('/');
      uploads.push({
        key,
        bytes: fs.readFileSync(filePath),
        contentType: guessContentType(key),
        label: `file_asset:${key}`,
      });
    }
  }

  if (!uploads.length) {
    console.log('[ensure-label-assets] No uploads requested.');
    return;
  }

  if (shouldLogJson()) {
    console.log(JSON.stringify({
      event: 'ensure_label_assets_start',
      bucket: ASSET_BUCKET,
      upsert,
      uploads: uploads.map((u) => ({ label: u.label, key: u.key, bytes: u.bytes.length })),
    }));
  } else {
    console.log(`[ensure-label-assets] Uploading ${uploads.length} assets to ${ASSET_BUCKET}...`);
    for (const u of uploads) {
      console.log(`- ${u.label}: ${u.key} (${u.bytes.length} bytes)`);
    }
  }

  for (const u of uploads) {
    const { error } = await supabase.storage
      .from(ASSET_BUCKET)
      .upload(u.key, u.bytes, { contentType: u.contentType, upsert });
    if (error) throw new Error(`upload failed (${u.label}): ${u.key}: ${error.message}`);
  }

  console.log('[ensure-label-assets] OK');
}

main().catch((err) => {
  console.error('[ensure-label-assets] Failed:', err.message);
  process.exit(1);
});
