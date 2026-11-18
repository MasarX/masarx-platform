import type { ReactNode } from 'react';

export const GENERIC_ACTION_ERROR =
  'The action could not be completed. Please try again or contact an administrator.';

export const GENERIC_VIEW_ERROR =
  'This section could not load. Please try again or contact an administrator.';

const TECHNICAL_MESSAGE_PATTERNS: RegExp[] = [
  /\bbackend\b/i,
  /\bread[-_\s]?back\b/i,
  /\bcanonical\b/i,
  /\brpc\b/i,
  /\bsupabase\b/i,
  /\bservice[-_\s]?role\b/i,
  /\bidempotenc(?:y|e)\b/i,
  /\bcorrelation(?:[_\s-]?id)?\b/i,
  /\btrace(?:[_\s-]?id)?\b/i,
  /\bdebug\b/i,
  /\bdiagnostic\b/i,
  /\braw[-_\s]?(?:table|backend|json|response|payload)\b/i,
  /\bnot seeded\b/i,
  /\bmissing-policy\b/i,
  /\bprojection\b/i,
  /\bVITE_[A-Z0-9_]+\b/,
  /\b(public|api)\.[a-z0-9_]+\b/i,
  /\bui_[a-z0-9_]+_v\d+\b/i,
  /\b[a-z0-9]+(?:_[a-z0-9]+){2,}_v\d+\b/i,
  /\b[a-z0-9]+(?:_[a-z0-9]+){1,}_(?:failed|rejected|unavailable|missing|pending|blocked|error)\b/i,
];

export function isTechnicalOperatorMessage(message: string): boolean {
  return TECHNICAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function sanitizeOperatorMessage(
  message: string,
  fallback = GENERIC_ACTION_ERROR,
): string {
  const trimmed = message.trim();
  if (!trimmed) return fallback;
  return isTechnicalOperatorMessage(trimmed) ? fallback : trimmed;
}

export function sanitizeOperatorNode(
  node: ReactNode,
  fallback = GENERIC_ACTION_ERROR,
): ReactNode {
  return typeof node === 'string' ? sanitizeOperatorMessage(node, fallback) : node;
}
