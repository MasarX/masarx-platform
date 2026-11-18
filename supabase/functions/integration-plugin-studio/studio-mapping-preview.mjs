// Called only after actor capability admission. No JavaScript mapping fallback.
export async function previewRuntimeMapping(client, source, mappingConfig) {
  try {
    const { data, error } = await client.rpc('integration_studio_preview_mapping_v1', {
      p_source: source,
      p_mapping_config: mappingConfig,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid mapping preview result');
    }
    return data;
  } catch {
    const error = new Error('studio.preview.unavailable');
    error.status = 503;
    error.code = 'studio.preview.unavailable';
    throw error;
  }
}
