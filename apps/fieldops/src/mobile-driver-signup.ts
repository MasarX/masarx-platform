/** Public browser entry only: opening it never grants membership or clearance. */
export function resolveDriverSignupUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.href;
  } catch { return null; }
}

export async function openDriverSignup(value: unknown, linking: {
  canOpenURL(url: string): Promise<boolean>; openURL(url: string): Promise<unknown>;
}): Promise<void> {
  const url = resolveDriverSignupUrl(value);
  if (!url || !await linking.canOpenURL(url)) throw new Error("driver_signup_unavailable");
  await linking.openURL(url);
}
