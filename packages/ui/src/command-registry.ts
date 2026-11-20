import type { UiCommandDefinition, UiCommandRegistry } from "@masarx/api";
import { normalizeCommandRegistry } from "@masarx/api";

export type CommandRegistryResult = {
  commands: UiCommandDefinition[];
  error: unknown | null;
};

export { normalizeCommandRegistry };

type RegistryClient = { commandRegistry: () => Promise<UiCommandRegistry> };
type RegistryCacheOptions = { cacheKey?: string | null; ttlMs?: number | null };

const successfulReads = new WeakMap<RegistryClient, {
  key: string;
  expiresAt: number;
  result: CommandRegistryResult;
}>();

export async function fetchCommandRegistry(
  client: RegistryClient,
  options: RegistryCacheOptions = {},
): Promise<CommandRegistryResult> {
  const key = options.cacheKey?.trim();
  const configuredTtl = options.ttlMs ?? Number(process.env.UI_COMMAND_REGISTRY_CACHE_TTL_MS);
  const ttlMs = Number.isFinite(configuredTtl) ? Math.max(0, configuredTtl) : 60_000;
  const cached = key && ttlMs > 0 ? successfulReads.get(client) : undefined;
  if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.result;

  // Server clients have request-local identity. Scope keys alone cannot identify a principal.
  if (cached) successfulReads.delete(client);
  try {
    const registry = await client.commandRegistry();
    const result = { commands: normalizeCommandRegistry(registry), error: null };
    if (key && ttlMs > 0) successfulReads.set(client, { key, expiresAt: Date.now() + ttlMs, result });
    return result;
  } catch (error) {
    return { commands: [], error };
  }
}
