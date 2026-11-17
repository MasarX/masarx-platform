type CacheEntry = {
  bytes: Uint8Array;
  expiresAt: number;
};

// Keep worker asset reuse bounded by both retained bytes and entry count.
export class AssetCache {
  private entries = new Map<string, CacheEntry>();
  private retainedBytes = 0;

  constructor(
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly maxEntries = 128,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): Uint8Array | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.bytes;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retainedBytes -= entry.bytes.byteLength;
    this.entries.delete(key);
  }

  set(key: string, bytes: Uint8Array): void {
    this.delete(key);
    if (bytes.byteLength > this.maxBytes || this.maxEntries <= 0 || this.ttlMs <= 0) return;
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries || this.retainedBytes + bytes.byteLength > this.maxBytes)
    ) {
      this.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { bytes, expiresAt: this.now() + this.ttlMs });
    this.retainedBytes += bytes.byteLength;
  }
}
