// Project the final copy; inference and executable configuration keep their input.
export const projectStudioPayload = async (client, payload) => {
  try {
    const { data, error } = await client.rpc("integration_plugin_redact_projection_v1", { p_value: payload });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new Error("Studio response projection failed");
  }
};
