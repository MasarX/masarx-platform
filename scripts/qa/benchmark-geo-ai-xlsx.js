#!/usr/bin/env node
/**
 * Geo AI Accuracy Benchmark (XLSX)
 *
 * Runs the production Geo AI address extraction path end-to-end:
 *   start_workflow_run(workflow_geocoding_standard) ->
 *   progress_workflow_run(...) ->
 *   get_job_call_spec(outbound_id) -> fetch(spec) ->
 *   mark_outbound_call_success/failure(...)
 *
 * This is intentionally row-driven:
 * - Which AI/provider runs is determined by `geocoding_policy.address_normalization.ai_extract`.
 * - HTTP specs come from `operation_templates` via `get_job_call_spec`.
 *
 * Safety:
 * - Never prints auth headers / API keys.
 * - Requires explicit confirmation for large paid runs.
 *
 * Examples:
 *   ENV_FILE=config/env/.env.cloud node scripts/qa/benchmark-geo-ai-xlsx.js --input "Test Adresses.xlsx" --sheet "export (12)" --scenario line_only --limit 25
 *   ENV_FILE=config/env/.env.cloud node scripts/qa/benchmark-geo-ai-xlsx.js --input "Test Adresses.xlsx" --sheet "export (12)" --scenario line_plus_city --limit 200 --confirm-paid
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');

const { loadEnv } = require('../utils/load-env');
const { parseFlagArgs } = require('../utils/cli-args');

const DEFAULT_COLUMNS = Object.freeze({
  id: 'Id',
  country: 'Country',
  city: 'City',
  districtEn: 'District name en',
  districtAr: 'District name ar',
  addressLine: 'Test address lines',
});

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function toInt(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toText(value) {
  const s = String(value == null ? '' : value);
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeTokenText(value) {
  return toText(value).toLowerCase();
}

function classifyAddressLineLanguage(value) {
  const s = toText(value);
  if (!s) return 'empty';
  const arabicCount = (s.match(/[\u0600-\u06FF]/g) || []).length;
  const latinCount = (s.match(/[A-Za-z]/g) || []).length;
  if (arabicCount > 0 && latinCount === 0) return 'ar_only';
  if (latinCount > 0 && arabicCount === 0) return 'lat_only';
  if (arabicCount > 0 && latinCount > 0) return 'mixed';
  return 'other';
}

function includesAnyToken(actual, tokens = []) {
  const haystack = normalizeTokenText(actual);
  if (!haystack) return false;
  return (tokens || []).some((token) => {
    const needle = normalizeTokenText(token);
    return needle ? haystack.includes(needle) : false;
  });
}

function resolveColumns(flags) {
  return {
    id: flags['col-id'] || DEFAULT_COLUMNS.id,
    country: flags['col-country'] || DEFAULT_COLUMNS.country,
    city: flags['col-city'] || DEFAULT_COLUMNS.city,
    districtEn: flags['col-district-en'] || DEFAULT_COLUMNS.districtEn,
    districtAr: flags['col-district-ar'] || DEFAULT_COLUMNS.districtAr,
    addressLine: flags['col-address-line'] || DEFAULT_COLUMNS.addressLine,
  };
}

async function loadXlsxRows(inputPath, sheetName) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);

  const availableSheets = workbook.worksheets.map((worksheet) => worksheet.name);
  const effectiveSheet =
    sheetName && workbook.getWorksheet(sheetName)
      ? sheetName
      : availableSheets[0];

  if (!effectiveSheet || !workbook.getWorksheet(effectiveSheet)) {
    throw new Error(
      `Sheet not found. Requested="${sheetName || ''}", available=${JSON.stringify(
        availableSheets,
      )}`,
    );
  }

  const sheet = workbook.getWorksheet(effectiveSheet);
  const headerRow = sheet.getRow(1);
  const headers = [];

  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const header = toText(cell.text || cell.value || '');
    if (header) {
      headers[colNumber - 1] = header;
    }
  });

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = {};
    headers.forEach((header, index) => {
      if (!header) return;
      const cell = row.getCell(index + 1);
      item[header] = toText(cell.text || '');
    });
    rows.push(item);
  });

  return rows;
}

function buildCases(rows, columns, scenario) {
  const scenarioKey = String(scenario || '').trim();
  const scenarioList =
    scenarioKey === 'matrix' || scenarioKey === 'all'
      ? [
          'line_only',
          'line_plus_city',
          'district_only_en_plus_city',
          'district_only_ar_plus_city',
        ]
      : [scenarioKey || 'line_only'];

  const cases = [];
  for (const row of rows) {
    const addressLine = toText(row[columns.addressLine]);
    const city = toText(row[columns.city]);
    const districtEn = toText(row[columns.districtEn]);
    const districtAr = toText(row[columns.districtAr]);
    const country = toText(row[columns.country]);
    const rowId = toText(row[columns.id]);

    if (!addressLine) continue;

    const baseId = rowId || randomUUID();
    const expected = {
      row_id: rowId || null,
      country_raw: country || null,
      city_raw: city || null,
      district_en_raw: districtEn || null,
      district_ar_raw: districtAr || null,
    };

    for (const s of scenarioList) {
      if (s === 'line_only') {
        cases.push({
          id: `${baseId}::${s}`,
          scenario: s,
          input: { address_line: addressLine, city_hint: '' },
          expected,
          features: { address_lang: classifyAddressLineLanguage(addressLine) },
        });
        continue;
      }

      if (s === 'line_plus_city') {
        cases.push({
          id: `${baseId}::${s}`,
          scenario: s,
          input: { address_line: addressLine, city_hint: city },
          expected,
          features: { address_lang: classifyAddressLineLanguage(addressLine) },
        });
        continue;
      }

      if (s === 'district_only_en_plus_city') {
        if (!districtEn) continue;
        cases.push({
          id: `${baseId}::${s}`,
          scenario: s,
          input: { address_line: districtEn, city_hint: city },
          expected,
          features: { address_lang: classifyAddressLineLanguage(districtEn) },
        });
        continue;
      }

      if (s === 'district_only_ar_plus_city') {
        if (!districtAr) continue;
        cases.push({
          id: `${baseId}::${s}`,
          scenario: s,
          input: { address_line: districtAr, city_hint: city },
          expected,
          features: { address_lang: classifyAddressLineLanguage(districtAr) },
        });
        continue;
      }

      throw new Error(`Unknown scenario "${s}"`);
    }
  }
  return cases;
}

async function selectDefaultOrgClientSender(client) {
  const { rows } = await client.query(
    `
      SELECT
        o.id AS organization_id,
        c.id AS client_id,
        s.id AS sender_id
      FROM organizations o
      JOIN clients c ON c.organization_id = o.id
      JOIN senders s ON s.client_id = c.id
      ORDER BY o.created_at
      LIMIT 1
    `,
  );

  if (!rows.length) {
    throw new Error(
      'Seed data missing: expected at least one organization/client/sender row',
    );
  }

  return rows[0];
}

async function resolveWorkflowTemplateId(client, workflowName) {
  const { rows } = await client.query(
    `
      SELECT id::uuid AS id
      FROM workflow_templates
      WHERE name = $1::text
      ORDER BY created_at
      LIMIT 1
    `,
    [workflowName],
  );
  if (!rows.length) {
    throw new Error(`Workflow template not found: ${workflowName}`);
  }
  return rows[0].id;
}

async function resolveGeocodingPolicy(client, scopeType, scopeId) {
  const params = [scopeType];
  const query = `
    SELECT resolve_settings(
      'geocoding_policy',
      $1::text,
      ${scopeId ? '$2::uuid' : 'NULL::uuid'}
    ) AS policy
  `;
  if (scopeId) params.push(scopeId);
  const { rows } = await client.query(query, params);
  return rows[0]?.policy ?? null;
}

function extractAiPolicy(policy) {
  const ai =
    policy?.address_normalization?.ai_extract &&
    typeof policy.address_normalization.ai_extract === 'object'
      ? policy.address_normalization.ai_extract
      : null;

  return {
    enabled: Boolean(ai?.enabled),
    operationTemplateId: toText(ai?.operation_template_id) || null,
    fallbackCountry: toText(ai?.fallback_country) || null,
    writeFields: Array.isArray(ai?.write_fields) ? ai.write_fields : null,
    overwriteExisting: Boolean(ai?.overwrite_existing),
  };
}

function deriveExpectedCountryIso2(countryRaw, fallbackCountry) {
  const raw = toText(countryRaw).toUpperCase();
  if (raw && /^[A-Z]{2}$/.test(raw)) return raw;
  const fallback = toText(fallbackCountry).toUpperCase();
  return fallback && /^[A-Z]{2}$/.test(fallback) ? fallback : null;
}

async function prefetchCityTokenMap(client, organizationId, cityNames) {
  const map = {};
  const unique = Array.from(
    new Set((cityNames || []).map((c) => toText(c)).filter(Boolean)),
  );

  for (const cityRaw of unique) {
    const tokens = new Set([cityRaw]);
    const { rows } = await client.query(
      `
        SELECT name_canonical, name_arabic, alternate_names
        FROM canonical_cities
        WHERE organization_id = $1::uuid
          AND (
            lower(name_canonical) = lower($2::text)
            OR lower(COALESCE(name_arabic, '')) = lower($2::text)
            OR $2::text = ANY(COALESCE(alternate_names, ARRAY[]::text[]))
          )
        ORDER BY created_at
        LIMIT 1
      `,
      [organizationId, cityRaw],
    );

    const row = rows[0] || null;
    if (row?.name_canonical) tokens.add(String(row.name_canonical));
    if (row?.name_arabic) tokens.add(String(row.name_arabic));
    if (Array.isArray(row?.alternate_names)) {
      for (const alt of row.alternate_names) {
        if (alt) tokens.add(String(alt));
      }
    }

    map[cityRaw] = Array.from(tokens).filter(Boolean);
  }

  return map;
}

function annotateCaseFeatures(cases, cityTokenMap) {
  for (const c of cases) {
    const expected = c.expected || {};
    const cityTokens = expected.city_raw
      ? cityTokenMap?.[expected.city_raw] || [expected.city_raw]
      : [];

    const districtTokens = [
      ...(expected.district_en_raw ? [expected.district_en_raw] : []),
      ...(expected.district_ar_raw ? [expected.district_ar_raw] : []),
    ];

    const addressLine = c.input?.address_line || '';
    c.features = {
      ...(c.features || {}),
      address_has_city_token: cityTokens.length
        ? includesAnyToken(addressLine, cityTokens)
        : false,
      address_has_district_token: districtTokens.length
        ? includesAnyToken(addressLine, districtTokens)
        : false,
    };
  }
}

async function insertBenchmarkAddress(
  client,
  { organizationId, clientId },
  { rawInput, city, province, country },
) {
  const id = randomUUID();
  const { rows } = await client.query(
    `
      INSERT INTO addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        normalized_line1,
        normalized_line2,
        district,
        city,
        province,
        country,
        validation_status
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::text,
        NULL,
        NULL,
        ''::text,
        $5::text,
        $6::text,
        $7::text,
        'pending'
      )
      RETURNING id::text AS id
    `,
    [
      id,
      organizationId,
      clientId,
      rawInput,
      city ?? '',
      province ?? '',
      country ?? '',
    ],
  );
  return rows[0]?.id;
}

async function startWorkflowRun(client, workflowTemplateId, context) {
  const { rows } = await client.query(
    `SELECT start_workflow_run($1::uuid, $2::jsonb)::text AS id`,
    [workflowTemplateId, context],
  );
  return rows[0]?.id;
}

async function progressWorkflowRun(client, workflowRunId, operationResult = {}) {
  const { rows } = await client.query(
    `SELECT progress_workflow_run($1::uuid, $2::jsonb) AS res`,
    [workflowRunId, operationResult],
  );
  return rows[0]?.res;
}

async function fetchRunSteps(client, workflowRunId) {
  const { rows } = await client.query(
    `
      SELECT
        id::text AS id,
        operation_name,
        step_status,
        sequence_order,
        metadata
      FROM workflow_run_steps
      WHERE workflow_run_id = $1::uuid
      ORDER BY sequence_order
    `,
    [workflowRunId],
  );
  return rows;
}

async function fetchLatestOutboundCallForStep(client, stepId) {
  const { rows } = await client.query(
    `
      SELECT
        id::text AS id,
        status,
        context
      FROM outbound_calls
      WHERE workflow_run_step_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [stepId],
  );
  return rows[0] || null;
}

async function waitForOutboundCall(client, workflowRunId, operationName) {
  const maxProgress = 12;
  for (let i = 0; i < maxProgress; i += 1) {
    await progressWorkflowRun(client, workflowRunId);
    const steps = await fetchRunSteps(client, workflowRunId);
    const step = steps.find((s) => s.operation_name === operationName);
    if (!step) continue;
    if (step.step_status !== 'in_progress') continue;
    const outbound = await fetchLatestOutboundCallForStep(client, step.id);
    if (!outbound) continue;
    return { step, outbound };
  }

  throw new Error(
    `Outbound call not created for operation "${operationName}" within ${maxProgress} progress iterations`,
  );
}

async function callHttpSpecWithRetries(spec, opts = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('global.fetch missing; Node 18+ is required');
  }

  const maxAttempts = toInt(opts.maxAttempts, 3) || 3;
  const baseDelayMs = toInt(opts.baseDelayMs, 500) || 500;

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const res = await fetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: JSON.stringify(spec.body),
    });
    const durationMs = Date.now() - startedAt;

    let resBody = null;
    let resText = '';
    try {
      resBody = await res.json();
    } catch (_) {
      try {
        resText = await res.text();
      } catch (_) {}
    }

    last = {
      status: res.status,
      body: resBody || null,
      text: resBody ? '' : resText,
      durationMs,
      retryAfter: res.headers.get('retry-after'),
    };

    if (res.status !== 429) break;

    const retryAfterSeconds = last.retryAfter ? Number(last.retryAfter) : NaN;
    const delayMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(0, retryAfterSeconds) * 1000
      : baseDelayMs * 2 ** (attempt - 1);

    await new Promise((r) => setTimeout(r, Math.min(delayMs, 10_000)));
  }

  return last;
}

async function markOutboundCallResult(client, outboundId, result) {
  const responseJson =
    result && result.body
      ? result.body
      : result && result.text
        ? { raw_text: String(result.text).slice(0, 4000) }
        : {};

  if (result.status >= 200 && result.status < 300) {
    await client.query(
      `
        SELECT public.mark_outbound_call_success(
          $1::uuid,
          $2::int,
          '{}'::jsonb,
          $3::jsonb,
          $4::int
        )
      `,
      [outboundId, result.status, responseJson, result.durationMs],
    );
    return;
  }

  await client.query(
    `
      SELECT public.mark_outbound_call_failure(
        $1::uuid,
        $2::int,
        '{}'::jsonb,
        $3::jsonb,
        $4::text
      )
    `,
    [
      outboundId,
      result.status,
      responseJson,
      `http_${result.status}`,
    ],
  );
}

async function fetchAddressFields(client, addressId, clientId) {
  const { rows } = await client.query(
    `
      SELECT
        normalized_line1,
        normalized_line2,
        district,
        city,
        country,
        correction_count
      FROM addresses
      WHERE id = $1::uuid AND client_id = $2::uuid
    `,
    [addressId, clientId],
  );
  return rows[0] || null;
}

function evaluateCase(caseItem, actual, policy, tokenMaps = {}) {
  const expected = caseItem.expected || {};
  const expectedCountryIso2 = deriveExpectedCountryIso2(
    expected.country_raw,
    policy?.fallbackCountry,
  );

  const shouldEvaluateCity = !toText(caseItem?.input?.city_hint);
  const tokensCity = expected.city_raw
    ? tokenMaps.cityTokensByCityRaw?.[expected.city_raw] || [expected.city_raw]
    : [];
  const tokensDistrict = [
    ...(expected.district_en_raw ? [expected.district_en_raw] : []),
    ...(expected.district_ar_raw ? [expected.district_ar_raw] : []),
  ];

  const out = {
    ok: true,
    hardErrors: [],
    matches: {
      country_iso2: null,
      city: null,
      district: null,
    },
  };

  const line1 = toText(actual?.normalized_line1);
  if (!line1) {
    out.hardErrors.push('normalized_line1 missing');
  }

  const country = toText(actual?.country);
  const countryIso2 = country ? country.toUpperCase() : '';
  if (!countryIso2) {
    out.hardErrors.push('country missing');
    if (expectedCountryIso2) out.matches.country_iso2 = false;
  } else if (!/^[A-Z]{2}$/.test(countryIso2)) {
    out.hardErrors.push(`country not ISO2 ("${country}")`);
    if (expectedCountryIso2) out.matches.country_iso2 = false;
  } else {
    out.matches.country_iso2 = expectedCountryIso2
      ? countryIso2 === expectedCountryIso2
      : null;
  }

  const city = toText(actual?.city);
  if (shouldEvaluateCity) {
    if (!city) {
      out.hardErrors.push('city missing');
      if (tokensCity.length) out.matches.city = false;
    } else if (tokensCity.length) {
      out.matches.city = includesAnyToken(city, tokensCity);
    }
  }

  const district = toText(actual?.district);
  if (tokensDistrict.length) {
    out.matches.district = district ? includesAnyToken(district, tokensDistrict) : false;
  }

  const cityNorm = normalizeTokenText(city);
  const districtNorm = normalizeTokenText(district);
  if (cityNorm && districtNorm && cityNorm === districtNorm) {
    out.hardErrors.push('district equals city (should be omitted)');
  }

  out.ok = out.hardErrors.length === 0;
  return out;
}

async function runBenchmarkCase(
  client,
  ctx,
  workflowTemplateId,
  policy,
  caseItem,
  tokenMaps,
) {
  const startedAt = Date.now();

  await client.query('BEGIN');
  try {
    const addressId = await insertBenchmarkAddress(
      client,
      { organizationId: ctx.organization_id, clientId: ctx.client_id },
      {
        rawInput: caseItem.input.address_line,
        city: caseItem.input.city_hint ? caseItem.input.city_hint : '',
        province: caseItem.input.city_hint ? caseItem.input.city_hint : '',
        country: '',
      },
    );

    const workflowRunId = await startWorkflowRun(client, workflowTemplateId, {
      trigger_source: 'manual',
      trigger_type: 'qa_geo_ai_benchmark',
      organization_id: ctx.organization_id,
      client_id: ctx.client_id,
      sender_id: ctx.sender_id,
      address_id: addressId,
    });

    const { outbound } = await waitForOutboundCall(
      client,
      workflowRunId,
      'ai_extract_address',
    );

    const { rows: specRows } = await client.query(
      `SELECT get_job_call_spec($1::uuid) AS spec`,
      [outbound.id],
    );
    const spec = specRows[0]?.spec;
    if (!spec) throw new Error('get_job_call_spec returned empty spec for outbound call');

    const httpResult = await callHttpSpecWithRetries(spec, {
      maxAttempts: process.env.GEO_AI_BENCH_HTTP_MAX_ATTEMPTS,
      baseDelayMs: process.env.GEO_AI_BENCH_HTTP_RETRY_BASE_DELAY_MS,
    });

    if (!httpResult) throw new Error('HTTP call returned empty result');
    await markOutboundCallResult(client, outbound.id, httpResult);

    const actual = await fetchAddressFields(client, addressId, ctx.client_id);
    const evaluation = evaluateCase(caseItem, actual, policy, tokenMaps);

    return {
      id: caseItem.id,
      scenario: caseItem.scenario,
      expected: caseItem.expected,
      input: caseItem.input,
      actual,
      evaluation,
      features: caseItem.features || {},
      outbound: {
        id: outbound.id,
        http_status: httpResult.status,
        duration_ms: httpResult.durationMs,
      },
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

function initAgg() {
  return {
    total: 0,
    errors: 0,
    hard_ok: 0,
    http_2xx: 0,
    outbound_ms: [],
    accuracy: {
      city: { evaluated: 0, matched: 0 },
      district: { evaluated: 0, matched: 0 },
      country_iso2: { evaluated: 0, matched: 0 },
    },
  };
}

function addAgg(agg, r) {
  agg.total += 1;
  if (r.error) {
    agg.errors += 1;
    return;
  }

  if (r.evaluation?.ok) agg.hard_ok += 1;
  if (r.outbound?.http_status >= 200 && r.outbound?.http_status < 300) {
    agg.http_2xx += 1;
  }
  if (typeof r.outbound?.duration_ms === 'number') {
    agg.outbound_ms.push(r.outbound.duration_ms);
  }

  for (const k of ['city', 'district', 'country_iso2']) {
    const v = r.evaluation?.matches?.[k];
    if (v === null || v === undefined) continue;
    agg.accuracy[k].evaluated += 1;
    if (v === true) agg.accuracy[k].matched += 1;
  }
}

function finalizeAgg(agg) {
  const out = { ...agg };
  const durations = Array.isArray(agg.outbound_ms) ? agg.outbound_ms.slice() : [];
  out.p95_outbound_ms = null;
  out.p50_outbound_ms = null;
  if (durations.length) {
    durations.sort((a, b) => a - b);
    out.p50_outbound_ms = durations[Math.floor(durations.length * 0.5)] ?? durations[0];
    out.p95_outbound_ms =
      durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1];
  }
  delete out.outbound_ms;
  return out;
}

function computeSummary(results) {
  const overall = initAgg();
  const byScenario = {};
  const byLang = {};
  const byCityToken = { present: initAgg(), missing: initAgg() };
  const byDistrictToken = { present: initAgg(), missing: initAgg() };
  const byTokenCombo = {};

  for (const r of results) {
    addAgg(overall, r);

    const scenario = toText(r.scenario) || 'unknown';
    if (!byScenario[scenario]) byScenario[scenario] = initAgg();
    addAgg(byScenario[scenario], r);

    const lang = r.features?.address_lang || classifyAddressLineLanguage(r.input?.address_line);
    if (!byLang[lang]) byLang[lang] = initAgg();
    addAgg(byLang[lang], r);

    const hasCityToken = Boolean(r.features?.address_has_city_token);
    const hasDistrictToken = Boolean(r.features?.address_has_district_token);
    addAgg(hasCityToken ? byCityToken.present : byCityToken.missing, r);
    addAgg(hasDistrictToken ? byDistrictToken.present : byDistrictToken.missing, r);
    const comboKey = `city=${hasCityToken ? 1 : 0}|district=${hasDistrictToken ? 1 : 0}`;
    if (!byTokenCombo[comboKey]) byTokenCombo[comboKey] = initAgg();
    addAgg(byTokenCombo[comboKey], r);
  }

  const scenarioOut = {};
  for (const [k, v] of Object.entries(byScenario)) {
    scenarioOut[k] = finalizeAgg(v);
  }
  const langOut = {};
  for (const [k, v] of Object.entries(byLang)) {
    langOut[k] = finalizeAgg(v);
  }

  return {
    overall: finalizeAgg(overall),
    by_scenario: scenarioOut,
    by_address_lang: langOut,
    by_input_city_token: {
      present: finalizeAgg(byCityToken.present),
      missing: finalizeAgg(byCityToken.missing),
    },
    by_input_district_token: {
      present: finalizeAgg(byDistrictToken.present),
      missing: finalizeAgg(byDistrictToken.missing),
    },
    by_input_city_district_tokens: Object.fromEntries(
      Object.entries(byTokenCombo).map(([k, v]) => [k, finalizeAgg(v)]),
    ),
  };
}

function writeOutput(outDir, results, summary, metadata) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify(results, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify({ metadata, summary }, null, 2),
    'utf8',
  );

  const csvLines = [
    [
      'case_id',
      'scenario',
      'row_id',
      'address_lang',
      'address_has_city_token',
      'address_has_district_token',
      'input_address_line',
      'input_city_hint',
      'expected_city',
      'expected_district_en',
      'expected_district_ar',
      'actual_city',
      'actual_district',
      'actual_country',
      'match_city',
      'match_district',
      'match_country_iso2',
      'http_status',
      'outbound_ms',
    ].join(','),
  ];

  for (const r of results) {
    const row = [
      r.id,
      r.scenario,
      r.expected?.row_id || '',
      r.features?.address_lang || classifyAddressLineLanguage(r.input?.address_line),
      r.features?.address_has_city_token ?? '',
      r.features?.address_has_district_token ?? '',
      JSON.stringify(r.input?.address_line || ''),
      JSON.stringify(r.input?.city_hint || ''),
      JSON.stringify(r.expected?.city_raw || ''),
      JSON.stringify(r.expected?.district_en_raw || ''),
      JSON.stringify(r.expected?.district_ar_raw || ''),
      JSON.stringify(r.actual?.city || ''),
      JSON.stringify(r.actual?.district || ''),
      JSON.stringify(r.actual?.country || ''),
      r.evaluation?.matches?.city ?? '',
      r.evaluation?.matches?.district ?? '',
      r.evaluation?.matches?.country_iso2 ?? '',
      r.outbound?.http_status ?? '',
      r.outbound?.duration_ms ?? '',
    ];
    csvLines.push(row.join(','));
  }

  fs.writeFileSync(path.join(outDir, 'results.csv'), csvLines.join('\n'), 'utf8');
}

async function main() {
  const flags = parseFlagArgs(process.argv.slice(2));

  const inputArg = flags.input || 'Test Adresses.xlsx';
  const inputPath = path.isAbsolute(inputArg)
    ? inputArg
    : path.join(process.cwd(), inputArg);
  const sheetName = flags.sheet || '';
  const scenario = String(flags.scenario || 'line_only').trim();

  const columns = resolveColumns(flags);

  const offset = toInt(flags.offset, 0) || 0;
  const limit = toInt(flags.limit, null);
  const confirmPaid = isTruthy(flags['confirm-paid'] || flags.confirm_paid);

  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required (set ENV_FILE=config/env/.env.cloud or export DATABASE_URL).',
    );
  }

  const rows = await loadXlsxRows(inputPath, sheetName);
  const sliced = rows.slice(offset, limit ? offset + limit : undefined);
  const cases = buildCases(sliced, columns, scenario);

  const maxWithoutConfirm = 25;
  if (!confirmPaid && cases.length > maxWithoutConfirm) {
    throw new Error(
      `Refusing to run ${cases.length} live cases without --confirm-paid (paid calls). Re-run with --confirm-paid or reduce --limit (<=${maxWithoutConfirm}).`,
    );
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const ctx =
      flags['sender-id'] && flags['client-id'] && flags['organization-id']
        ? {
            organization_id: flags['organization-id'],
            client_id: flags['client-id'],
            sender_id: flags['sender-id'],
          }
        : await selectDefaultOrgClientSender(client);

    const workflowTemplateId = await resolveWorkflowTemplateId(
      client,
      'workflow_geocoding_standard',
    );

    const policy = await resolveGeocodingPolicy(client, 'sender', ctx.sender_id);
    const ai = extractAiPolicy(policy || {});
    if (!ai.enabled) {
      throw new Error(
        'geocoding_policy.address_normalization.ai_extract.enabled is false for this sender scope; enable it then retry.',
      );
    }
    if (!ai.operationTemplateId) {
      throw new Error(
        'geocoding_policy.address_normalization.ai_extract.operation_template_id is missing; set it then retry.',
      );
    }

    const cityTokenMap = await prefetchCityTokenMap(
      client,
      ctx.organization_id,
      cases.map((c) => c.expected?.city_raw),
    );
    annotateCaseFeatures(cases, cityTokenMap);
    const tokenMaps = { cityTokensByCityRaw: cityTokenMap };

    const results = [];
    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      try {
        const result = await runBenchmarkCase(
          client,
          ctx,
          workflowTemplateId,
          ai,
          c,
          tokenMaps,
        );
        results.push(result);
        // eslint-disable-next-line no-console
        console.log(
          `[geo-ai-bench] ${i + 1}/${cases.length} ok case=${c.id} http=${result.outbound.http_status} outbound_ms=${result.outbound.duration_ms}`,
        );
      } catch (error) {
        results.push({
          id: c.id,
          scenario: c.scenario,
          expected: c.expected,
          input: c.input,
          features: c.features || {},
          error: error?.message || String(error),
        });
        // eslint-disable-next-line no-console
        console.warn(
          `[geo-ai-bench] ${i + 1}/${cases.length} fail case=${c.id}: ${error?.message || error}`,
        );
      }
    }

    const summary = computeSummary(results);
    const outDir = path.join(
      process.cwd(),
      'tmp',
      `geo-ai-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    );
    writeOutput(outDir, results, summary, {
      input: path.basename(inputPath),
      sheet: sheetName || '(first)',
      scenario,
      offset,
      limit: limit ?? null,
      operation_template_id: ai.operationTemplateId,
      fallback_country: ai.fallbackCountry,
    });

    // eslint-disable-next-line no-console
    console.log(`[geo-ai-bench] Done. Output: ${outDir}`);
    // eslint-disable-next-line no-console
    console.log(
      `[geo-ai-bench] Summary: hard_ok=${summary.overall.hard_ok}/${summary.overall.total} errors=${summary.overall.errors} http_2xx=${summary.overall.http_2xx}/${summary.overall.total} p95_outbound_ms=${summary.overall.p95_outbound_ms ?? 'n/a'}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  loadEnv();
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[geo-ai-bench] ${err?.message || err}`);
    process.exit(1);
  });
}

module.exports = {
  annotateCaseFeatures,
  buildCases,
  classifyAddressLineLanguage,
  deriveExpectedCountryIso2,
  evaluateCase,
  extractAiPolicy,
  includesAnyToken,
  loadXlsxRows,
  normalizeTokenText,
  prefetchCityTokenMap,
  resolveColumns,
};
