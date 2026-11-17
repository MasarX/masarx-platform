export declare const sharedTextEncoder: TextEncoder;
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
export declare function resolveObjectPath(target: unknown, path: string): unknown;
export declare function renderTemplate(template: unknown, context: Record<string, unknown>): unknown;
export declare function computeHmac(
  algorithm: "HMAC-SHA256" | "HMAC-SHA512",
  secret: string,
  message: string,
  encoding?: "hex" | "base64"
): Promise<string>;
