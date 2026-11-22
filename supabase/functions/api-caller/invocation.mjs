const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_OVERRIDE_KEYS = Object.freeze(["url", "method", "headers", "body", "http_allowed_host"]);
const JOB_KEYS = new Set(["job_id", "timeout_seconds"]);
const BATCH_KEYS = new Set(["batch", "concurrency"]);

export const MAX_BATCH_SIZE = 10;
export const MAX_BATCH_CONCURRENCY = 1;
export const MAX_BATCH_RESULT_BYTES = 8_192;
export const MAX_BATCH_ERROR_BYTES = 384;

const textEncoder = new TextEncoder();

export class InvocationValidationError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = "InvocationValidationError";
    this.status = status;
  }
}

const requireBoundedInteger = (value, name, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvocationValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

export const validateInvocationPayload = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvocationValidationError("Request body must be a JSON object");
  }

  for (const key of FORBIDDEN_OVERRIDE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new InvocationValidationError(`${key} is server-resolved and cannot be overridden`);
    }
  }

  const hasJob = Object.prototype.hasOwnProperty.call(value, "job_id");
  const hasBatch = Object.prototype.hasOwnProperty.call(value, "batch");
  if (hasJob === hasBatch) {
    throw new InvocationValidationError("Provide exactly one of job_id or batch");
  }

  const operation = hasJob ? "job" : "batch";
  const allowedKeys = operation === "job" ? JOB_KEYS : BATCH_KEYS;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new InvocationValidationError(`${key} is not allowed for ${operation} execution`);
    }
  }

  if (operation === "job") {
    const jobId = String(value.job_id || "").trim();
    if (!UUID_PATTERN.test(jobId)) {
      throw new InvocationValidationError("job_id must be a UUID");
    }

    const timeoutSeconds = value.timeout_seconds === undefined
      ? undefined
      : requireBoundedInteger(value.timeout_seconds, "timeout_seconds", 1, 600);
    return {
      operation,
      payload: {
        job_id: jobId,
        ...(timeoutSeconds === undefined ? {} : { timeout_seconds: timeoutSeconds }),
      },
    };
  }

  const batch = requireBoundedInteger(value.batch, "batch", 1, MAX_BATCH_SIZE);
  const concurrency = value.concurrency === undefined
    ? undefined
    : requireBoundedInteger(value.concurrency, "concurrency", 1, MAX_BATCH_CONCURRENCY);
  return {
    operation,
    payload: {
      batch,
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  };
};

const truncateUtf8 = (value, maxBytes) => {
  const normalized = String(value ?? "");
  if (textEncoder.encode(normalized).byteLength <= maxBytes) return normalized;

  let result = "";
  for (const character of normalized) {
    const candidate = `${result}${character}`;
    if (textEncoder.encode(candidate).byteLength > maxBytes) break;
    result = candidate;
  }
  return result;
};

export const compactBatchJobResult = (jobResult) => {
  const result = jobResult?.result && typeof jobResult.result === "object"
    ? jobResult.result
    : jobResult && typeof jobResult === "object"
    ? jobResult
    : {};
  const error = jobResult?.error ?? result.error;

  return {
    job_id: String(jobResult?.job_id ?? ""),
    success: jobResult?.success === true,
    status: Number.isInteger(result.status) ? result.status : 0,
    completed: result.completed === true,
    latency_ms: Number.isFinite(Number(result.latency_ms))
      ? Math.max(0, Math.floor(Number(result.latency_ms)))
      : 0,
    ...(error ? { error: truncateUtf8(error, MAX_BATCH_ERROR_BYTES) } : {}),
  };
};

const serializedBytes = (value) => textEncoder.encode(JSON.stringify(value)).byteLength;

export const buildCompactBatchResponse = (
  jobResults,
  { maxBytes = MAX_BATCH_RESULT_BYTES } = {},
) => {
  const compactResults = [];

  for (const result of jobResults) {
    const compact = compactBatchJobResult(result);
    const candidate = {
      jobs: [...compactResults, compact],
      summary: {
        claimed: jobResults.length,
        returned: compactResults.length + 1,
        omitted: jobResults.length - compactResults.length - 1,
      },
    };
    if (serializedBytes(candidate) > maxBytes) {
      continue;
    }
    compactResults.push(compact);
  }

  const response = {
    jobs: compactResults,
    summary: {
      claimed: jobResults.length,
      returned: compactResults.length,
      omitted: jobResults.length - compactResults.length,
    },
  };

  if (serializedBytes(response) > maxBytes) {
    throw new InvocationValidationError("Batch result byte budget is too small", 500);
  }
  return response;
};

export const mergeServerDispatch = (spec, invocation = {}) => {
  const resolvedTimeout = Number.isFinite(Number(spec?.timeout_seconds))
    ? Math.max(Math.floor(Number(spec.timeout_seconds)), 1)
    : 30;
  const requestedTimeout = Number.isFinite(Number(invocation?.timeout_seconds))
    ? Math.max(Math.floor(Number(invocation.timeout_seconds)), 1)
    : null;

  return {
    url: spec?.url,
    ...(typeof spec?.http_allowed_host === "string" ? { http_allowed_host: spec.http_allowed_host } : {}),
    method: spec?.method || "POST",
    headers: spec?.headers && Object.keys(spec.headers).length ? { ...spec.headers } : undefined,
    body: spec?.body ?? {},
    timeout_seconds: requestedTimeout === null
      ? resolvedTimeout
      : Math.min(resolvedTimeout, requestedTimeout),
  };
};
