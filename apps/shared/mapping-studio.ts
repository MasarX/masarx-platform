import type { MappingArtifact } from "@masarx/api";

const MAPPING_ARTIFACT_VALUES = [
  "tabular_import",
  "webhook_inbound",
  "api_outbound",
  "integration_plugin",
] as const satisfies readonly MappingArtifact[];

export function resolveMappingArtifact(value: string | undefined): MappingArtifact {
  return MAPPING_ARTIFACT_VALUES.includes(value as MappingArtifact) ? value as MappingArtifact : "tabular_import";
}
