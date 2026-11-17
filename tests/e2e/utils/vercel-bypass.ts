export function resolveVercelBypassHeaders(env: NodeJS.ProcessEnv) {
  const secret = String(
    env.VERCEL_AUTOMATION_BYPASS_SECRET ||
      env.VERCEL_PROTECTION_BYPASS_SECRET ||
      ""
  ).trim();
  if (!secret) return null;
  return {
    "x-vercel-protection-bypass": secret,
    "x-vercel-set-bypass-cookie": "true",
  } as Record<string, string>;
}
