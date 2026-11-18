export function requestOAuthTokens(endpoint: string, parameters: Record<string, string>): Promise<{ status: number; body: unknown }>;
