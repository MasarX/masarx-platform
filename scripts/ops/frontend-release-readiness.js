#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const PHASE_PLAN_PATTERN = /^PLAN-(\d{6})-frontend-console-portal-prod-ready-phase(\d+)\.md$/i;

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    format: 'text',
    strict: false,
    phaseStart: 32,
    phaseEnd: 39,
    plansDir: path.join(process.cwd(), 'docs', 'ops', 'plans'),
    guidePath: path.join(process.cwd(), 'docs', 'guides', 'FRONTEND_UI_UX.md'),
  };
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] || '').trim();
    const next = String(argv[i + 1] || '').trim();
    if (token === '--strict') out.strict = true;
    else if (token === '--format' && next) {
      out.format = next;
      i += 1;
    } else if (token.startsWith('--format=')) out.format = token.split('=').slice(1).join('=').trim();
    else if (token === '--phase-start' && next) {
      out.phaseStart = parseInt(next, 10);
      i += 1;
    } else if (token.startsWith('--phase-start=')) out.phaseStart = parseInt(token.split('=').slice(1).join('=').trim(), 10);
    else if (token === '--phase-end' && next) {
      out.phaseEnd = parseInt(next, 10);
      i += 1;
    } else if (token.startsWith('--phase-end=')) out.phaseEnd = parseInt(token.split('=').slice(1).join('=').trim(), 10);
    else if (token === '--plans-dir' && next) {
      out.plansDir = path.resolve(next);
      i += 1;
    } else if (token.startsWith('--plans-dir=')) out.plansDir = path.resolve(token.split('=').slice(1).join('=').trim());
    else if (token === '--guide' && next) {
      out.guidePath = path.resolve(next);
      i += 1;
    } else if (token.startsWith('--guide=')) out.guidePath = path.resolve(token.split('=').slice(1).join('=').trim());
  }
  if (!Number.isFinite(out.phaseStart)) out.phaseStart = 32;
  if (!Number.isFinite(out.phaseEnd)) out.phaseEnd = 39;
  if (out.phaseEnd < out.phaseStart) {
    const tmp = out.phaseStart;
    out.phaseStart = out.phaseEnd;
    out.phaseEnd = tmp;
  }
  return out;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseFrontmatterValue(body, key) {
  if (!body) return '';
  const regex = new RegExp(`^${String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+?)\\s*$`, 'm');
  const match = regex.exec(body);
  return match && match[1] ? String(match[1]).trim() : '';
}

function parseChecklistChecked(body, step) {
  if (!body) return false;
  const regex = new RegExp(`^-\\s*\\[(x|X)\\]\\s*${String(step).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm');
  return regex.test(body);
}

function classifyStatus(rawStatus) {
  const normalized = String(rawStatus || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.includes('done')) return 'done';
  if (normalized.includes('in_progress') || normalized.includes('in progress')) return 'in_progress';
  if (normalized.includes('pending')) return 'pending';
  if (normalized.includes('draft')) return 'draft';
  if (normalized.includes('queued')) return 'queued';
  if (normalized.includes('blocked')) return 'blocked';
  if (normalized.includes('hold')) return 'on_hold';
  if (normalized.includes('cancel')) return 'canceled';
  if (normalized.includes('superseded')) return 'superseded';
  return 'other';
}

function collectPhasePlanMetadata({ plansDir, phaseStart, phaseEnd }) {
  const archiveDir = path.join(plansDir, 'archive');

  function listDir(dirPath) {
    try {
      return fs.readdirSync(dirPath);
    } catch {
      return [];
    }
  }

  function parseCandidate({ phase, ym, filename, filePath, source }) {
    const body = readFileSafe(filePath) || '';
    const planId = parseFrontmatterValue(body, 'plan_id') || filename.replace(/\.md$/i, '');
    const statusRaw = parseFrontmatterValue(body, 'status').replace(/\s+#.*$/, '').trim();
    const currentStep = parseFrontmatterValue(body, 'current_step');
    return {
      phase,
      ym,
      filename,
      filePath,
      source,
      missing: false,
      planId,
      status: statusRaw || 'unknown',
      statusKind: classifyStatus(statusRaw),
      currentStep,
      s98Checked: parseChecklistChecked(body, 'S98'),
      s99Checked: parseChecklistChecked(body, 'S99'),
    };
  }

  const candidatesByPhase = new Map();
  const sources = [
    { source: 'active', dir: plansDir },
    { source: 'archive', dir: archiveDir },
  ];

  for (const { source, dir } of sources) {
    for (const name of listDir(dir)) {
      const match = PHASE_PLAN_PATTERN.exec(name);
      if (!match) continue;
      const ym = String(match[1]);
      const phase = parseInt(match[2], 10);
      if (!Number.isFinite(phase) || phase < phaseStart || phase > phaseEnd) continue;
      const filePath = path.join(dir, name);
      const parsed = parseCandidate({ phase, ym, filename: name, filePath, source });
      const list = candidatesByPhase.get(phase) || [];
      list.push(parsed);
      candidatesByPhase.set(phase, list);
    }
  }

  function compareCandidates(left, right) {
    if (left.ym !== right.ym) return left.ym > right.ym ? -1 : 1;
    const leftDone = left.statusKind === 'done';
    const rightDone = right.statusKind === 'done';
    if (leftDone !== rightDone) return leftDone ? -1 : 1;
    if (left.source !== right.source) {
      if (left.source === 'archive') return -1;
      if (right.source === 'archive') return 1;
    }
    if (left.filename !== right.filename) return left.filename > right.filename ? -1 : 1;
    return 0;
  }

  const phases = [];
  for (let phase = phaseStart; phase <= phaseEnd; phase += 1) {
    const candidates = candidatesByPhase.get(phase) || [];
    if (candidates.length === 0) {
      phases.push({
        phase,
        missing: true,
        planId: '',
        status: 'missing',
        statusKind: 'missing',
        currentStep: '',
        s98Checked: false,
        s99Checked: false,
      });
      continue;
    }

    const sorted = [...candidates].sort(compareCandidates);
    const selected = sorted[0];
    phases.push(selected);
  }
  return phases;
}

function parseGuidePhaseStatuses(guideBody, { phaseStart, phaseEnd }) {
  const statuses = new Map();
  if (!guideBody) return statuses;
  const rowRegex = /^\|\s*(\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/gm;
  let match;
  while ((match = rowRegex.exec(guideBody)) !== null) {
    const phase = parseInt(String(match[1] || ''), 10);
    if (!Number.isFinite(phase) || phase < phaseStart || phase > phaseEnd) continue;
    const status = String(match[3] || '').trim();
    statuses.set(phase, {
      phase,
      focus: String(match[2] || '').trim(),
      status,
      statusKind: classifyStatus(status),
      exitCriteria: String(match[4] || '').trim(),
    });
  }
  return statuses;
}

function buildFrontendReleaseReadinessReport({
  plansDir,
  guidePath,
  phaseStart,
  phaseEnd,
}) {
  const phasePlans = collectPhasePlanMetadata({ plansDir, phaseStart, phaseEnd });
  const guideBody = readFileSafe(guidePath) || '';
  const guideStatuses = parseGuidePhaseStatuses(guideBody, { phaseStart, phaseEnd });
  const rows = phasePlans.map((phasePlan) => {
    const guide = guideStatuses.get(phasePlan.phase) || null;
    const checks = [];
    if (phasePlan.missing) checks.push('plan_missing');
    if (!guide) checks.push('guide_row_missing');
    if (phasePlan.statusKind !== 'done') checks.push('plan_not_done');
    if (!phasePlan.s98Checked) checks.push('s98_unchecked');
    if (!phasePlan.s99Checked) checks.push('s99_unchecked');
    if (guide && guide.statusKind !== 'done') checks.push('guide_not_done');
    return {
      ...phasePlan,
      guideStatus: guide ? guide.status : 'missing',
      guideStatusKind: guide ? guide.statusKind : 'missing',
      guideFocus: guide ? guide.focus : '',
      blockers: checks,
    };
  });

  const blockerRows = rows.filter((row) => row.blockers.length > 0);
  const doneRows = rows.filter((row) => row.blockers.length === 0);
  const ready = blockerRows.length === 0;

  return {
    generatedAt: new Date().toISOString(),
    phaseRange: { start: phaseStart, end: phaseEnd },
    readyForPromotion: ready,
    summary: {
      total: rows.length,
      done: doneRows.length,
      blocked: blockerRows.length,
    },
    rows,
  };
}

function evaluateFrontendReleaseGate(report) {
  const blockers = [];
  for (const row of report.rows || []) {
    if (!Array.isArray(row.blockers) || row.blockers.length === 0) continue;
    blockers.push({
      phase: row.phase,
      blockers: row.blockers,
      planId: row.planId,
    });
  }
  return {
    ok: blockers.length === 0,
    blockers,
  };
}

function formatTextReport(report) {
  const lines = [];
  lines.push(`Frontend release readiness (${report.phaseRange.start}-${report.phaseRange.end})`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(
    `Summary: ${report.summary.done}/${report.summary.total} phases promotion-ready` +
      ` (${report.summary.blocked} blocked)`
  );
  lines.push('');
  for (const row of report.rows) {
    const header = `Phase ${row.phase} | plan=${row.planId || '<missing>'} | status=${row.status} | step=${row.currentStep || '-'}`;
    lines.push(header);
    lines.push(`  guide_status=${row.guideStatus}`);
    if (row.blockers.length) {
      lines.push(`  blockers=${row.blockers.join(',')}`);
    } else {
      lines.push('  blockers=<none>');
    }
  }
  return lines.join('\n');
}

function runCli() {
  const args = parseArgs();
  const report = buildFrontendReleaseReadinessReport({
    plansDir: args.plansDir,
    guidePath: args.guidePath,
    phaseStart: args.phaseStart,
    phaseEnd: args.phaseEnd,
  });
  if (args.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTextReport(report));
  }
  if (args.strict) {
    const gate = evaluateFrontendReleaseGate(report);
    if (!gate.ok) {
      console.error('[frontend-release-readiness] strict gate failed');
      for (const blocker of gate.blockers) {
        console.error(
          `[frontend-release-readiness] phase ${blocker.phase} (${blocker.planId || 'missing'}) -> ${blocker.blockers.join(',')}`
        );
      }
      process.exit(1);
    }
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  PHASE_PLAN_PATTERN,
  parseArgs,
  parseFrontmatterValue,
  parseChecklistChecked,
  classifyStatus,
  collectPhasePlanMetadata,
  parseGuidePhaseStatuses,
  buildFrontendReleaseReadinessReport,
  evaluateFrontendReleaseGate,
  formatTextReport,
};
