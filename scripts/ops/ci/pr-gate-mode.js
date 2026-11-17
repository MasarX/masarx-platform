#!/usr/bin/env node
/**
 * pr-gate-mode.js
 *
 * Resolves whether PR Gate should run in full mode or verify-only mode.
 * This keeps workflow policy dynamic and configurable through repo variables.
 *
 * Outputs (github-output/json):
 * - run_full: 1|0
 * - mode: merge-group|full|full-on-pr|verify-only|verify-only-draft
 * - reason: machine-readable reason
 * - full_on_pr_actions: normalized CSV of PR actions that enable full mode
 * - full_on_pr_action_allowed: 1|0
 * - full_mode_events: normalized CSV of events where PR_GATE_CI enables full mode
 * - full_mode_event_allowed: 1|0
 */
/* eslint-disable no-console */
const fs = require('fs');

const DEFAULT_FULL_ON_PR_ACTIONS = ['opened', 'reopened', 'ready_for_review'];
const DEFAULT_FULL_MODE_EVENTS = ['merge_group', 'workflow_dispatch'];

function die(msg) {
  console.error(`[pr-gate-mode] ${msg}`);
  process.exit(1);
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function parseActionsCsv(value) {
  const raw = String(value || '').trim();
  const items = (raw ? raw.split(',') : [])
    .map((v) => String(v || '').trim().toLowerCase())
    .filter(Boolean);
  const uniq = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    uniq.push(item);
  }
  return uniq;
}

function resolveFullOnPrActions(value) {
  const actions = parseActionsCsv(value);
  if (actions.length > 0) return actions;
  return [...DEFAULT_FULL_ON_PR_ACTIONS];
}

function resolveFullModeEvents(value) {
  const events = parseActionsCsv(value);
  if (events.length > 0) return events;
  return [...DEFAULT_FULL_MODE_EVENTS];
}

function normalizeAction(value) {
  return String(value || '').trim().toLowerCase();
}

function resolvePrGateMode(input = {}) {
  const eventName = String(input.eventName || '').trim();
  const eventAction = normalizeAction(input.eventAction);
  const prGateCi = isTruthy(input.prGateCi);
  const prGateFullOnPr = isTruthy(input.prGateFullOnPr);
  const sameRepoPr = isTruthy(input.sameRepoPr);
  const prIsDraft = isTruthy(input.prIsDraft);
  const fullOnPrActions = resolveFullOnPrActions(input.prGateFullOnPrActions);
  const fullOnPrActionAllowed = fullOnPrActions.includes(eventAction);
  const fullModeEvents = resolveFullModeEvents(input.prGateCiEvents);
  const fullModeEventAllowed = fullModeEvents.includes(eventName);

  if (eventName === 'merge_group') {
    return {
      runFull: true,
      mode: 'merge-group',
      reason: 'merge_group',
      fullOnPrActions,
      fullOnPrActionAllowed,
      fullModeEvents,
      fullModeEventAllowed,
    };
  }

  if (eventName === 'workflow_dispatch') {
    return {
      runFull: true,
      mode: 'full',
      reason: 'workflow_dispatch',
      fullOnPrActions,
      fullOnPrActionAllowed,
      fullModeEvents,
      fullModeEventAllowed,
    };
  }

  if (eventName === 'pull_request' && prIsDraft) {
    return {
      runFull: false,
      mode: 'verify-only-draft',
      reason: 'draft_pr',
      fullOnPrActions,
      fullOnPrActionAllowed,
      fullModeEvents,
      fullModeEventAllowed,
    };
  }

  if (prGateCi && fullModeEventAllowed) {
    return {
      runFull: true,
      mode: 'full',
      reason: `pr_gate_ci:${eventName || 'unknown'}`,
      fullOnPrActions,
      fullOnPrActionAllowed,
      fullModeEvents,
      fullModeEventAllowed,
    };
  }

  if (eventName === 'pull_request' && prGateFullOnPr) {
    if (!sameRepoPr) {
      return {
        runFull: false,
        mode: 'verify-only',
        reason: 'fork_pr',
        fullOnPrActions,
        fullOnPrActionAllowed,
        fullModeEvents,
        fullModeEventAllowed,
      };
    }
    if (fullOnPrActionAllowed) {
      return {
        runFull: true,
        mode: 'full-on-pr',
        reason: `pr_gate_full_on_pr:${eventAction || 'unknown'}`,
        fullOnPrActions,
        fullOnPrActionAllowed,
        fullModeEvents,
        fullModeEventAllowed,
      };
    }
    return {
      runFull: false,
      mode: 'verify-only',
      reason: `pr_gate_full_on_pr_action_filtered:${eventAction || 'unknown'}`,
      fullOnPrActions,
      fullOnPrActionAllowed,
      fullModeEvents,
      fullModeEventAllowed,
    };
  }

  return {
    runFull: false,
    mode: 'verify-only',
    reason: 'default_verify_only',
    fullOnPrActions,
    fullOnPrActionAllowed,
    fullModeEvents,
    fullModeEventAllowed,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { format: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--format') out.format = String(argv[i + 1] || '').trim();
    if (arg === '--format') i += 1;
    else if (arg.startsWith('--format=')) out.format = arg.split('=').slice(1).join('=').trim();
  }
  return out;
}

function writeGithubOutput(outputs) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) die('GITHUB_OUTPUT not set; use --format json for local runs.');
  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}=${String(value == null ? '' : value)}`);
  }
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function formatOutputs(mode) {
  return {
    run_full: mode.runFull ? '1' : '0',
    mode: mode.mode,
    reason: mode.reason,
    full_on_pr_actions: mode.fullOnPrActions.join(','),
    full_on_pr_action_allowed: mode.fullOnPrActionAllowed ? '1' : '0',
    full_mode_events: mode.fullModeEvents.join(','),
    full_mode_event_allowed: mode.fullModeEventAllowed ? '1' : '0',
  };
}

function main() {
  const { format } = parseArgs();
  const decision = resolvePrGateMode({
    eventName: process.env.EVENT_NAME,
    eventAction: process.env.EVENT_ACTION,
    prGateCi: process.env.PR_GATE_CI,
    prGateCiEvents: process.env.PR_GATE_CI_EVENTS,
    prGateFullOnPr: process.env.PR_GATE_FULL_ON_PR,
    prGateFullOnPrActions: process.env.PR_GATE_FULL_ON_PR_ACTIONS,
    sameRepoPr: process.env.SAME_REPO_PR,
    prIsDraft: process.env.PR_IS_DRAFT,
  });
  const out = formatOutputs(decision);
  const normalizedFormat = String(format || '').trim().toLowerCase();

  if (normalizedFormat === 'github-output') writeGithubOutput(out);
  else process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

  console.log(
    `[pr-gate-mode] event=${String(process.env.EVENT_NAME || '').trim() || '<unknown>'} ` +
    `action=${normalizeAction(process.env.EVENT_ACTION) || '<none>'} ` +
    `run_full=${out.run_full} mode=${out.mode} reason=${out.reason}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_FULL_ON_PR_ACTIONS,
  DEFAULT_FULL_MODE_EVENTS,
  isTruthy,
  parseActionsCsv,
  resolveFullOnPrActions,
  resolveFullModeEvents,
  resolvePrGateMode,
  formatOutputs,
};
