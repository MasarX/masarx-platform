'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sanitize, environmentSecrets, failureDetails } = require('./diagnostics.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(label, action, wait = sleep, { attempts = 3, retryable = () => true, quiet = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await action(attempt); }
    catch (error) {
      if (!quiet) console.error(`${label}: attempt ${attempt}/${attempts} failed: ${sanitize(error.message)}`);
      if (attempt === attempts || !retryable(error)) throw error;
      const delay = 5000 * 3 ** (attempt - 1);
      if (!quiet) console.log(`${label}: retrying after ${delay}ms`);
      await wait(delay);
    }
  }
}

// Read complete lines before redaction, including credentials split across pipe chunks.
function lines(consume) {
  let pending = '';
  return { push(chunk) {
    pending += chunk;
    const parts = pending.split(/\r\n|\r|\n/);
    pending = parts.pop();
    parts.forEach(consume);
  }, end() { if (pending) consume(pending); pending = ''; } };
}

function run(command, args, { env = process.env, timeout = 600000, quiet = false, printQuietFailure = true, logFile, logPrefix = '', includeStderr = false,
  onLine = () => false, idleMs = 0, idleMessage = () => 'No progress before deadline', subscribeProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const secrets = environmentSecrets(env);
    let stdout = ''; let stderr = ''; let combined = ''; let stopped; let idle; let killTimer;
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      clearTimeout(idle);
      const kill = signal => {
        try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {}
      };
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 5000);
    };
    const touch = () => {
      if (!idleMs || stopped) return;
      clearTimeout(idle);
      const progressAt = Date.now();
      idle = setTimeout(() => stop(idleMessage(Date.now() - progressAt)), idleMs);
    };
    const consume = line => {
      try { if (onLine(line)) touch(); } catch (error) { stop(error.message); }
      if (!quiet) {
        const clean = logPrefix + sanitize(line, secrets);
        console.log(clean);
        if (logFile) fs.appendFileSync(logFile, `${clean}\n`);
      }
    };
    const out = lines(consume); const err = lines(consume);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { stdout += text; if (includeStderr) combined += text; out.push(text); });
    child.stderr.on('data', text => { stderr += text; if (includeStderr) combined += text; err.push(text); });
    const timer = setTimeout(() => stop(`Process exceeded ${timeout}ms`), timeout);
    touch();
    const unsubscribe = idleMs ? subscribeProgress?.(touch) : undefined;
    let launchError;
    child.on('error', error => { launchError = error; });
    child.on('close', (status, signal) => {
      unsubscribe?.(); out.end(); err.end();
      clearTimeout(timer); clearTimeout(idle); clearTimeout(killTimer);
      if (status !== 0 || launchError || stopped) {
        const error = new Error(sanitize(stopped || launchError?.message || `${path.basename(command)} ${args[0]} failed (exit ${status})`, secrets));
        error.failure = { ...failureDetails({ status, signal, error: launchError, stdout, stderr }, secrets),
          timeout: Boolean(stopped), output: sanitize(`${stdout}\n${stderr}`, secrets) };
        // Quiet machine-readable output is still available, redacted and complete, on failure.
        if (quiet && printQuietFailure) console.error(error.failure.output);
        reject(error);
      } else resolve(includeStderr ? combined : stdout);
    });
  });
}

async function stage(report, name, action) {
  const start = Date.now();
  const entry = { name, startedAt: new Date(start).toISOString(), status: 'running' };
  report.stages.push(entry);
  console.log(`[${entry.startedAt}] START ${name}`);
  try { const result = await action(); entry.status = 'passed'; return result; }
  catch (error) { entry.status = 'failed'; throw error; }
  finally {
    entry.endedAt = new Date().toISOString(); entry.durationMs = Date.now() - start;
    console.log(`[${entry.endedAt}] END ${name}: ${entry.status}, ${(entry.durationMs / 1000).toFixed(3)}s`);
  }
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const table = report.stages.map(s => `| ${s.name} | ${s.startedAt} | ${s.endedAt} | ${(s.durationMs / 1000).toFixed(3)} | ${s.status} |`).join('\n');
    const { stages, failure, ...counts } = report;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${report.shard ? `pgTAP ${report.shard}` : 'Database build'}\n\n| Stage | Start UTC | End UTC | Seconds | Result |\n|---|---|---|---:|---|\n${table}\n\n<pre>${sanitize(JSON.stringify(counts, null, 2)).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>\n${failure ? '\nFailure: see the complete sanitized log and diagnostic artifact.\n' : ''}`);
  }
}

module.exports = { run, retry, stage, writeReport, lines };
