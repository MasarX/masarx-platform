export declare function readEnv(primary: string, fallbacks?: string[]): string;
export declare function normaliseHeaders(headers: Headers): Record<string, string>;
export declare function toResponseBody(response: Response): Promise<unknown>;
export declare function redactLogValue(value: unknown, maxDepth?: number): unknown;
export declare function resolveCorrelationId(req: Request, fallback?: string): string;
export declare function classifyError(error: unknown): string;
export declare function buildStructuredLogRecord(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  context?: Record<string, unknown>
): Record<string, unknown>;
export declare function logStructured(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  context?: Record<string, unknown>
): Record<string, unknown>;
export declare function normalizeHeaderKey(key: string): string;
export declare function extractToken(
  req: Request,
  options?: {
    prefer?: "webhook" | "authorization";
    allowWebhookHeader?: boolean;
    allowAuthorization?: boolean;
    allowQueryParam?: boolean;
  }
): string | null;
export declare function parseRequestBody(req: Request): Promise<{ raw: string; json: Record<string, unknown> }>;
/** Non-cryptographic defense after native JWT admission. */
export declare function validateInternalEdgeClaims(
  claims: Record<string, unknown>,
  role: string,
  options?: { nowSeconds?: number }
): { ok: true } | { ok: false; status: number; message: string };
