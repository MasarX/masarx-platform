#!/usr/bin/env node
/* eslint-disable no-console */

function classifyUiStateId(stateId) {
  const value = String(stateId || '').trim().toLowerCase();
  if (!value) return '';
  if (value.endsWith('-ready')) return 'ready';
  if (value.endsWith('-auth-required')) return 'auth-required';
  if (value.endsWith('-context-unavailable')) return 'wrong-tenant';
  if (value.endsWith('-missing-env')) return 'callback-mismatch';
  if (
    value.endsWith('-resource-blocked') ||
    value.endsWith('-not-found') ||
    value.endsWith('-error')
  ) {
    return 'resource-unavailable';
  }
  return '';
}

function classifyHostedUiFailure(text) {
  const raw = String(text || '');
  const normalized = raw.toLowerCase();

  if (!normalized.trim()) {
    return { failure_class: '', ui_state: '', matched_text: '' };
  }

  const explicitFailureClassMatch = raw.match(/failure_class=([a-z0-9-]+)/i);
  if (explicitFailureClassMatch) {
    const explicitFailureClass = String(explicitFailureClassMatch[1] || '').trim().toLowerCase();
    if (explicitFailureClass) {
      return {
        failure_class: explicitFailureClass,
        ui_state: explicitFailureClass,
        matched_text: explicitFailureClassMatch[0],
      };
    }
  }

  if (/demo accounts readiness check failed/i.test(raw)) {
    return {
      failure_class: 'demo-accounts-unready',
      ui_state: 'demo-accounts-unready',
      matched_text: raw.match(/.*demo accounts readiness check failed.*/i)?.[0] || '',
    };
  }

  if (/ui admin auth readiness check failed/i.test(raw)) {
    return {
      failure_class: /tenant or user not found|did not become ready within retry window/i.test(raw)
        ? 'admin-auth-unready'
        : 'resource-unavailable',
      ui_state: /tenant or user not found|did not become ready within retry window/i.test(raw)
        ? 'admin-auth-unready'
        : 'resource-unavailable',
      matched_text: raw.match(/.*ui admin auth readiness check failed.*/i)?.[0] || '',
    };
  }

  if (/demo accounts missing|no demo user available|demo password missing|cleanup manifest missing|manifest missing/i.test(raw)) {
    return { failure_class: 'demo-account-missing', ui_state: 'demo-account-missing', matched_text: raw.match(/.*(demo accounts missing|no demo user available|demo password missing|cleanup manifest missing|manifest missing).*/i)?.[0] || '' };
  }

  const expectedStateMatch = raw.match(/Expected\s+(?:console|portal)\s+resource\s+ready\s+state,\s+got\s+([a-z0-9-]+)/i);
  if (expectedStateMatch) {
    const uiState = classifyUiStateId(expectedStateMatch[1]);
    return {
      failure_class: uiState || 'resource-unavailable',
      ui_state: uiState || '',
      matched_text: expectedStateMatch[0],
    };
  }

  if (/ui context unavailable/i.test(raw)) {
    return { failure_class: 'wrong-tenant', ui_state: 'wrong-tenant', matched_text: raw.match(/.*ui context unavailable.*/i)?.[0] || '' };
  }

  if (/auth-required gate remained visible/i.test(raw)) {
    return { failure_class: 'auth-required', ui_state: 'auth-required', matched_text: raw.match(/.*auth-required gate remained visible.*/i)?.[0] || '' };
  }

  if (/redirect.*not allowed|callback/i.test(raw)) {
    return { failure_class: 'callback-mismatch', ui_state: 'callback-mismatch', matched_text: raw.match(/.*(redirect.*not allowed|callback).*/i)?.[0] || '' };
  }

  if (/resource-unavailable|resource blocked|not found|returned http|unexpected content-type|response too small/i.test(raw)) {
    return { failure_class: 'resource-unavailable', ui_state: 'resource-unavailable', matched_text: raw.match(/.*(resource-unavailable|resource blocked|not found|returned http|unexpected content-type|response too small).*/i)?.[0] || '' };
  }

  return { failure_class: '', ui_state: '', matched_text: '' };
}

function isInfrastructureRetryableText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return /fetch failed|networkerror|timed out|timeout|socket hang up|econnreset|econnrefused|enotfound|eai_again|net::err_|target page, context or browser has been closed|browser has been closed|returned http 5\d\d|gateway timeout|temporarily unavailable|service unavailable/i.test(raw);
}

function classifyHostedUiRetryPolicy({ failureClass = '', outputText = '', stepLabel = '' } = {}) {
  const normalizedFailureClass = String(failureClass || '').trim().toLowerCase();
  const normalizedStep = String(stepLabel || '').trim().toLowerCase();
  const infrastructureRetryable =
    normalizedFailureClass === 'resource-unavailable' &&
    isInfrastructureRetryableText(outputText);
  const retryable = infrastructureRetryable && (
    normalizedStep === 'ui_resource_preflight' ||
    normalizedStep === 'verify:cloud:ui' ||
    normalizedStep === 'verify:cloud:e2e-mandatory-pack'
  );

  return {
    retryable,
    retry_class: retryable ? 'infrastructure' : 'not-retryable',
    max_retries: retryable ? 1 : 0,
  };
}

function buildHostedUiGateSummary({
  status = 'passed',
  failedStep = '',
  outputText = '',
}) {
  const classification = classifyHostedUiFailure(outputText);
  return {
    generated_at: new Date().toISOString(),
    status: String(status || 'passed').trim(),
    failed_step: String(failedStep || '').trim(),
    failure_class: classification.failure_class || '',
    ui_state: classification.ui_state || '',
    matched_text: classification.matched_text || '',
  };
}

module.exports = {
  classifyUiStateId,
  classifyHostedUiFailure,
  classifyHostedUiRetryPolicy,
  buildHostedUiGateSummary,
  isInfrastructureRetryableText,
};
