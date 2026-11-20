import exec from 'k6/execution';
import { check, sleep } from 'k6';

export function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function buildWarmupSteadyScenarios({
  vus,
  duration,
  warmupIterations = 1,
  warmupDuration = '',
  warmupVus,
  warmupGracefulStop = '10s',
  warmupMaxDuration = '30s',
  steadyStartTime = '',
}) {
  const resolvedWarmupDuration = String(warmupDuration || '').trim();
  const resolvedWarmupVus = Math.max(1, Math.min(vus, positiveInteger(warmupVus, vus)));
  const resolvedSteadyStartTime = String(steadyStartTime || '').trim() || '5s';
  const steady = {
    executor: 'constant-vus',
    vus,
    duration,
    tags: { phase: 'steady' },
  };

  if (resolvedWarmupDuration) {
    return {
      warmup: {
        executor: 'constant-vus',
        vus: resolvedWarmupVus,
        duration: resolvedWarmupDuration,
        gracefulStop: warmupGracefulStop,
        tags: { phase: 'warmup' },
      },
      steady: {
        ...steady,
        startTime: resolvedSteadyStartTime,
      },
    };
  }

  if (!warmupIterations) {
    return { steady };
  }

  return {
    warmup: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: warmupIterations,
      maxDuration: warmupMaxDuration,
      tags: { phase: 'warmup' },
    },
    steady: {
      ...steady,
      startTime: resolvedSteadyStartTime,
    },
  };
}

export function phaseName() {
  return exec.scenario.name === 'warmup' ? 'warmup' : 'steady';
}

export function phaseTags(extra = {}) {
  return {
    ...extra,
    phase: phaseName(),
  };
}

export function checkWithPhase(value, checks) {
  return check(value, checks, phaseTags());
}

export function sleepDuringSteady(ms) {
  if (phaseName() === 'steady' && ms > 0) {
    sleep(ms / 1000);
  }
}
