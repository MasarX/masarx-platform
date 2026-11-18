// Synthesized, locale-neutral WAV cues are generated on first use and cached. The resolved audio policy can select a different cue per locale.

/**
 * Synthesizes a single-tone WAV file (16-bit PCM, mono, 22050 Hz) and returns
 * a base64-encoded `data:audio/wav;base64,...` URI. Pure function — no I/O,
 * no platform calls. Safe to call in any JS environment (Node + browser).
 *
 * The WAV uses a simple ADSR-style envelope (5 ms attack, 50 ms release) so
 * each cue feels like a single intentional UX beat instead of a clipped
 * square-wave click. Volume is fixed at 30% (0.3) to match the Web Audio
 * synthesis path in `mobile-audio-cue-player.ts` so the two playback modes
 * have perceptually equivalent loudness.
 */
export function synthSineWavBase64(
  frequency: number,
  durationMs: number,
  sampleRate: number = 22050,
): string {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(view, 8, "WAVE");

  // fmt chunk (16-byte PCM format chunk)
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // audio format = 1 (PCM)
  view.setUint16(22, 1, true); // num channels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = sampleRate * blockAlign
  view.setUint16(32, 2, true); // block align = numChannels * bitsPerSample/8
  view.setUint16(34, 16, true); // bits per sample

  // data chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Synthesize sine samples with simple ADSR envelope
  // - attack:  5 ms linear ramp up from silence
  // - sustain: full amplitude
  // - release: 50 ms linear ramp down to silence
  const attackSamples = Math.floor(0.005 * sampleRate);
  const releaseSamples = Math.floor(0.05 * sampleRate);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let envelope = 1.0;
    if (i < attackSamples) {
      envelope = i / attackSamples;
    } else if (i > numSamples - releaseSamples) {
      envelope = (numSamples - i) / releaseSamples;
    }
    // 30% volume to match the Web Audio path in mobile-audio-cue-player.ts
    const sample = Math.sin(2 * Math.PI * frequency * t) * envelope * 0.3;
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }

  return "data:audio/wav;base64," + arrayBufferToBase64(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  // Browser path
  if (typeof btoa !== "undefined") return btoa(binary);
  // Node fallback (Jest unit tests, SSR, edge runtimes)
  if (typeof Buffer !== "undefined") {
    return Buffer.from(binary, "binary").toString("base64");
  }
  // Last-resort manual base64 (defensive — should never fire in practice
  // because every supported runtime ships either btoa or Buffer).
  throw new Error(
    "[audio-cue-assets] No base64 encoder available (no btoa, no Buffer)",
  );
}

/** The cue bank maps the public asset keys to deterministic synthesized WAV data. */
export type AudioCueAssetKey =
  | "success"
  | "info"
  | "warning"
  | "error"
  | "neutral"
  | "shift_start"
  | "shift_end"
  | "scan_success"
  | "scan_failure";

/**
 * Tone bank — frequency + duration per asset key. Locale-neutral Western
 * pentatonic intervals (no culturally-loaded half-steps) so the same cue
 * is friendly across every tenant locale today.
 *
 *   - success:      G5 (783.99 Hz) — bright, completion-positive
 *   - info:         C5 (523.25 Hz) — calm, neutral acknowledgement
 *   - warning:      G4 (392.00 Hz) — assertive but not alarming
 *   - error:        A3 (220.00 Hz) — low, attention-demanding fault tone
 *   - neutral:      A4 (440.00 Hz) — concert-pitch fallback
 *   - shift_start:  E5 (659.25 Hz) — uplifting, day-start
 *   - shift_end:    A5 (880.00 Hz) — celebratory, day-end
 *   - scan_success: C6 (1046.50 Hz) — short ping, scan acknowledged
 *   - scan_failure: G3 (196.00 Hz) — low buzz, scan rejected
 *
 * Durations are calibrated so each cue feels like a single intentional UX
 * beat — short enough to never block the calling action, long enough to be
 * perceptually clear (100–320 ms range).
 */
const TONE_BANK: Record<
  AudioCueAssetKey,
  { frequency: number; durationMs: number }
> = {
  success: { frequency: 783.99, durationMs: 220 },
  info: { frequency: 523.25, durationMs: 140 },
  warning: { frequency: 392.0, durationMs: 180 },
  error: { frequency: 220.0, durationMs: 280 },
  neutral: { frequency: 440.0, durationMs: 120 },
  shift_start: { frequency: 659.25, durationMs: 320 },
  shift_end: { frequency: 880.0, durationMs: 280 },
  scan_success: { frequency: 1046.5, durationMs: 100 },
  scan_failure: { frequency: 196.0, durationMs: 240 },
};

// Lazy synthesis cache — populated on first access per key. Keeps cold start
// fast (no work at module load) and avoids paying the synthesis cost twice
// for the same cue across many call sites.
const _cache: Partial<Record<AudioCueAssetKey, string>> = {};

/**
 * Get the base64 `data:audio/wav;base64,...` URI for the given asset key.
 * The WAV is synthesized lazily on first call and cached for all subsequent
 * calls — repeated access returns the exact same string instance.
 */
export function getAudioCueAsset(key: AudioCueAssetKey): string {
  if (!_cache[key]) {
    const tone = TONE_BANK[key];
    _cache[key] = synthSineWavBase64(tone.frequency, tone.durationMs);
  }
  return _cache[key]!;
}

/**
 * List every asset key supported by the bank. Useful for tests and for
 * settings screens that want to preview every cue.
 */
export function listAudioCueAssetKeys(): AudioCueAssetKey[] {
  return Object.keys(TONE_BANK) as AudioCueAssetKey[];
}

/**
 * Get the synthesized-tone metadata (frequency + duration) for an asset
 * key. Pure read — does not trigger synthesis. Useful for tests and for
 * UI surfaces that want to display the tone parameters (e.g. a debug
 * settings panel listing every cue's pitch + length).
 */
export function getAudioCueMetadata(
  key: AudioCueAssetKey,
): { frequency: number; durationMs: number } {
  return TONE_BANK[key];
}

/**
 * Test-only helper to clear the lazy cache. NOT exported in the public
 * surface — call sites should never invalidate the cache because the
 * synthesized output is deterministic. Re-exported under `__test_only__`
 * for unit tests that want to assert cache behavior independently.
 */
export const __test_only__ = {
  clearCache(): void {
    for (const k of Object.keys(_cache) as AudioCueAssetKey[]) {
      delete _cache[k];
    }
  },
  cacheSize(): number {
    return Object.keys(_cache).length;
  },
};
