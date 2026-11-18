export declare function projectStudioPayload(
  client: { rpc(name: string, args: { p_value: Record<string, unknown> }): PromiseLike<{ data: unknown; error: unknown }> },
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>>;
