export function revalidatePath() {}

export function revalidateTag() {}

export function unstable_cache<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
  _keyParts?: string[],
  _options?: { revalidate?: number | false; tags?: string[] }
) {
  return fn;
}

