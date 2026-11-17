import type { UiCommandDefinition, UiCommandRegistry } from "@masarx/api";
import { normalizeCommandRegistry } from "@masarx/api";

export type CommandRegistryResult = {
  commands: UiCommandDefinition[];
  error: unknown | null;
};

export { normalizeCommandRegistry };

export async function fetchCommandRegistry(client: {
  commandRegistry: () => Promise<UiCommandRegistry>;
}): Promise<CommandRegistryResult> {
  try {
    const registry = await client.commandRegistry();
    return { commands: normalizeCommandRegistry(registry), error: null };
  } catch (error) {
    return { commands: [], error };
  }
}
