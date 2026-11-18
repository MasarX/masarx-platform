export const selectRpcAuthAttempts = (attempts, serviceOnly = false) =>
  serviceOnly
    ? attempts.filter((attempt) => !String(attempt?.label || "").startsWith("db-jwt"))
    : attempts;
