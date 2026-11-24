export function isMfaRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "PT403" &&
    "message" in error &&
    error.message === "mfa_required"
  );
}
