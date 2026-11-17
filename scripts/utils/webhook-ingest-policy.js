function normalizeWebhookIngestPolicy(value) {
  if (!value || typeof value !== 'object') return value;

  const out = { ...value };
  if (out.version === undefined || out.version === null) {
    out.version = 1;
  }

  const validation = out.validation;
  if (validation && typeof validation === 'object') {
    const idempotency = validation.idempotency;
    if (idempotency && typeof idempotency === 'object' && Object.prototype.hasOwnProperty.call(idempotency, 'normalize')) {
      const nextIdempotency = { ...idempotency };
      delete nextIdempotency.normalize;

      const nextValidation = { ...validation, idempotency: nextIdempotency };
      if (!Object.keys(nextIdempotency).length) {
        delete nextValidation.idempotency;
      }
      if (!Object.keys(nextValidation).length) {
        delete out.validation;
      } else {
        out.validation = nextValidation;
      }
    }
  }

  return out;
}

module.exports = {
  normalizeWebhookIngestPolicy,
};
