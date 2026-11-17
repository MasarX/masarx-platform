export type AuthMethod = "magic_link" | "password";

export function normalizeAuthEmail(value: string): string {
  return String(value || "")
    .replace(/[\s\u00A0\u200B-\u200D\uFEFF]+/g, "")
    .trim()
    .toLowerCase();
}

export function normalizeAuthMethods(methods: string[] | null | undefined): AuthMethod[] {
  if (!Array.isArray(methods)) return ["password"];
  const normalized = methods
    .map((method) => method.trim().toLowerCase())
    .filter((method): method is AuthMethod => method === "magic_link" || method === "password");
  const unique = Array.from(new Set(normalized));
  return unique.length ? unique : ["password"];
}

export function resolvePreferredAuthMethod(methods: AuthMethod[]): AuthMethod {
  if (methods.includes("password")) return "password";
  return methods[0] ?? "password";
}
