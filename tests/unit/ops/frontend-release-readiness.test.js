const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectPhasePlanMetadata,
  parseGuidePhaseStatuses,
  buildFrontendReleaseReadinessReport,
  evaluateFrontendReleaseGate,
} = require('../../../scripts/ops/frontend-release-readiness');

function makePlanBody({ planId, status, currentStep, s98, s99 }) {
  return [
    '---',
    `plan_id: ${planId}`,
    'title: Test Plan',
    'owner: @tests',
    `status: ${status}`,
    `current_step: ${currentStep}`,
    'updated: 2099-01-01',
    '---',
    '',
    'Checklist',
    `- [${s98 ? 'x' : ' '}] S98 - Objectives Gate`,
    `- [${s99 ? 'x' : ' '}] S99 - Tests Gate`,
    '',
  ].join('\n');
}

function writePlan({ plansDir, ym = '202602', phase, status = 'done', currentStep = 'S99', s98 = true, s99 = true }) {
  return writePlanToDir({
    targetDir: plansDir,
    ym,
    phase,
    status,
    currentStep,
    s98,
    s99,
  });
}

function writePlanToDir({ targetDir, ym = '202602', phase, status = 'done', currentStep = 'S99', s98 = true, s99 = true }) {
  const planId = `PLAN-${ym}-frontend-console-portal-prod-ready-phase${phase}`;
  fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${planId}.md`);
  fs.writeFileSync(
    filePath,
    makePlanBody({ planId, status, currentStep, s98, s99 }),
    'utf8'
  );
  return filePath;
}

function buildGuide({ phaseStart = 32, phaseEnd = 39, status = 'Done' } = {}) {
  const rows = [];
  rows.push('| Phase | Focus area | Current status | Exit criteria |');
  rows.push('| --- | --- | --- | --- |');
  for (let phase = phaseStart; phase <= phaseEnd; phase += 1) {
    rows.push(`| ${phase} | Focus ${phase} | ${status} | Exit ${phase} |`);
  }
  return rows.join('\n');
}

describe('frontend release readiness helpers', () => {
  let tmpRoot;
  let plansDir;
  let guidePath;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-release-readiness-'));
    plansDir = path.join(tmpRoot, 'docs', 'ops', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(path.join(plansDir, 'archive'), { recursive: true });
    guidePath = path.join(tmpRoot, 'docs', 'guides', 'FRONTEND_UI_UX.md');
    fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('collectPhasePlanMetadata prefers latest plan month per phase', () => {
    writePlan({ plansDir, ym: '202601', phase: 32, status: 'done', s98: true, s99: true });
    writePlan({ plansDir, ym: '202602', phase: 32, status: 'in_progress', currentStep: 'S95', s98: true, s99: false });
    const rows = collectPhasePlanMetadata({ plansDir, phaseStart: 32, phaseEnd: 32 });
    expect(rows).toHaveLength(1);
    expect(rows[0].planId).toBe('PLAN-202602-frontend-console-portal-prod-ready-phase32');
    expect(rows[0].statusKind).toBe('in_progress');
    expect(rows[0].s98Checked).toBe(true);
    expect(rows[0].s99Checked).toBe(false);
  });

  test('collectPhasePlanMetadata falls back to archived plan when active plan is missing', () => {
    writePlanToDir({
      targetDir: path.join(plansDir, 'archive'),
      ym: '202602',
      phase: 33,
      status: 'done',
      currentStep: 'S99',
      s98: true,
      s99: true,
    });

    const rows = collectPhasePlanMetadata({ plansDir, phaseStart: 33, phaseEnd: 33 });
    expect(rows).toHaveLength(1);
    expect(rows[0].statusKind).toBe('done');
    expect(rows[0].s98Checked).toBe(true);
    expect(rows[0].s99Checked).toBe(true);
    expect(rows[0].source).toBe('archive');
  });

  test('collectPhasePlanMetadata prefers archived done plan over active non-done plan for the same month', () => {
    writePlan({ plansDir, ym: '202602', phase: 34, status: 'draft', currentStep: 'S95', s98: false, s99: false });
    writePlanToDir({
      targetDir: path.join(plansDir, 'archive'),
      ym: '202602',
      phase: 34,
      status: 'done',
      currentStep: 'S99',
      s98: true,
      s99: true,
    });

    const rows = collectPhasePlanMetadata({ plansDir, phaseStart: 34, phaseEnd: 34 });
    expect(rows).toHaveLength(1);
    expect(rows[0].statusKind).toBe('done');
    expect(rows[0].s98Checked).toBe(true);
    expect(rows[0].s99Checked).toBe(true);
    expect(rows[0].source).toBe('archive');
  });

  test('parseGuidePhaseStatuses extracts table rows and status kinds', () => {
    const body = [
      '| Phase | Focus area | Current status | Exit criteria |',
      '| --- | --- | --- | --- |',
      '| 32 | Responsive tables | In progress (slice 1 implemented) | Exit |',
      '| 39 | Release sign-off | Pending | Exit |',
    ].join('\n');
    const statuses = parseGuidePhaseStatuses(body, { phaseStart: 32, phaseEnd: 39 });
    expect(statuses.get(32).statusKind).toBe('in_progress');
    expect(statuses.get(39).statusKind).toBe('pending');
  });

  test('buildFrontendReleaseReadinessReport flags blockers when phases are incomplete', () => {
    for (let phase = 32; phase <= 39; phase += 1) {
      writePlan({ plansDir, phase, status: 'done', s98: true, s99: true });
    }
    writePlan({ plansDir, phase: 39, status: 'in_progress', currentStep: 'S95', s98: true, s99: false });
    fs.writeFileSync(guidePath, buildGuide({ status: 'Done' }), 'utf8');

    const report = buildFrontendReleaseReadinessReport({
      plansDir,
      guidePath,
      phaseStart: 32,
      phaseEnd: 39,
    });
    expect(report.readyForPromotion).toBe(false);
    const phase39 = report.rows.find((row) => row.phase === 39);
    expect(phase39.blockers).toEqual(expect.arrayContaining(['plan_not_done', 's99_unchecked']));
  });

  test('evaluateFrontendReleaseGate passes when all phases are done and guide rows are done', () => {
    for (let phase = 32; phase <= 39; phase += 1) {
      writePlan({ plansDir, phase, status: 'done', s98: true, s99: true });
    }
    fs.writeFileSync(guidePath, buildGuide({ status: 'Done' }), 'utf8');
    const report = buildFrontendReleaseReadinessReport({
      plansDir,
      guidePath,
      phaseStart: 32,
      phaseEnd: 39,
    });
    const gate = evaluateFrontendReleaseGate(report);
    expect(report.readyForPromotion).toBe(true);
    expect(gate.ok).toBe(true);
    expect(gate.blockers).toHaveLength(0);
  });
});
