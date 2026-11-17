#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');

const DEFAULT_ALLOWED_ACTORS = ['github-actions[bot]', 'masarx-bot-app[bot]'];

function die(msg) {
  console.error(`[skip-approval-guard] ${msg}`);
  process.exit(1);
}

function parseCsv(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  for (const token of raw.split(',')) {
    const item = String(token || '').trim().toLowerCase();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function resolveAllowedActors(value) {
  const configured = parseCsv(value);
  if (configured.length > 0) return configured;
  return [...DEFAULT_ALLOWED_ACTORS];
}

function resolveSkipApprovalPolicy(input = {}) {
  const eventName = String(input.eventName || '').trim();
  const actor = String(input.actor || '').trim().toLowerCase();
  const skipApproval = isTruthy(input.skipApproval);
  const allowedActors = resolveAllowedActors(input.allowedActorsCsv);

  if (!skipApproval) {
    return {
      ok: true,
      reason: 'skip_approval_not_requested',
      actor,
      eventName,
      skipApproval,
      allowedActors,
    };
  }

  if (eventName !== 'workflow_dispatch') {
    return {
      ok: false,
      reason: 'skip_approval_only_allowed_on_workflow_dispatch',
      actor,
      eventName,
      skipApproval,
      allowedActors,
    };
  }

  if (!allowedActors.includes(actor)) {
    return {
      ok: false,
      reason: 'actor_not_allowed_for_skip_approval',
      actor,
      eventName,
      skipApproval,
      allowedActors,
    };
  }

  return {
    ok: true,
    reason: 'actor_allowed_for_skip_approval',
    actor,
    eventName,
    skipApproval,
    allowedActors,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { format: 'json' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '').trim();
    if (arg === '--format') {
      out.format = String(argv[i + 1] || '').trim() || 'json';
      i += 1;
    } else if (arg.startsWith('--format=')) {
      out.format = arg.split('=').slice(1).join('=').trim() || 'json';
    }
  }
  return out;
}

function writeGithubOutput(outputs) {
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  if (!outputPath) die('GITHUB_OUTPUT not set; use --format json for local runs.');
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${String(v == null ? '' : v)}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function formatOutputs(policy) {
  return {
    ok: policy.ok ? '1' : '0',
    reason: policy.reason,
    actor: policy.actor,
    event_name: policy.eventName,
    skip_approval: policy.skipApproval ? '1' : '0',
    allowed_actors: policy.allowedActors.join(','),
  };
}

function main() {
  const args = parseArgs();
  const policy = resolveSkipApprovalPolicy({
    eventName: process.env.GITHUB_EVENT_NAME || process.env.EVENT_NAME,
    actor: process.env.GITHUB_ACTOR_LOGIN || process.env.GITHUB_ACTOR,
    skipApproval: process.env.SKIP_APPROVAL,
    allowedActorsCsv: process.env.SKIP_APPROVAL_ALLOWED_ACTORS,
  });
  const out = formatOutputs(policy);
  const format = String(args.format || '').trim().toLowerCase();

  if (format === 'github-output') writeGithubOutput(out);
  else process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

  if (!policy.ok) {
    die(
      [
        `skip_approval denied (reason=${policy.reason})`,
        `event=${policy.eventName || '<unknown>'}`,
        `actor=${policy.actor || '<unknown>'}`,
        `allowed_actors=${policy.allowedActors.join(',') || '<none>'}`,
      ].join(' '),
    );
  }

  console.log(
    `[skip-approval-guard] ok reason=${policy.reason} event=${policy.eventName || '<unknown>'} actor=${policy.actor || '<unknown>'}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_ALLOWED_ACTORS,
  parseCsv,
  isTruthy,
  resolveAllowedActors,
  resolveSkipApprovalPolicy,
  formatOutputs,
};

