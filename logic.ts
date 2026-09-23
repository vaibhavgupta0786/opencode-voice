// Pure, host-independent logic for opencode-voice: VAD endpointing, PCM
// helpers, WAV encoding and STT URL building. No imports — unit-testable
// with plain node. tui.ts owns all host/IO concerns.

export const RATE = 16_000 // recorder streams 16-bit mono PCM at 16 kHz
export const TICK_MS = 50 // VAD evaluated in 50 ms windows (1600 bytes)

export interface VoiceOptions {
  stt?: string // base URL of OpenAI-compatible STT
  model?: string // STT model name
  silenceMs?: number // quiet time ending the utterance (auto mode only)
  maxMs?: number // hard cap per utterance
  startTimeoutMs?: number // give up if silent this long
  minSpeechMs?: number // voiced audio required
  vadThreshold?: number // peak amplitude counting as voice
  toggle?: boolean // f9 starts, f9 stops; pauses never end the take
  debug?: boolean
}

export const DEFAULTS: {
  stt: string
  model: string
  silenceMs: number
  maxMs: number
  startTimeoutMs: number
  minSpeechMs: number
  vadThreshold: number
  toggle: boolean
  debug: boolean
} = {
  stt: "http://127.0.0.1:8080/v1",
  model: "whisper-1",
  silenceMs: 900,
  maxMs: 60_000,
  startTimeoutMs: 4_000,
  minSpeechMs: 300,
  vadThreshold: 0.03,
  toggle: true,
  debug: false,
}

export type RequiredVoiceOptions = typeof DEFAULTS

export function mergeOptions(raw: VoiceOptions = {}): RequiredVoiceOptions {
  return {
    stt: raw.stt ?? DEFAULTS.stt,
    model: raw.model ?? DEFAULTS.model,
    silenceMs: raw.silenceMs ?? DEFAULTS.silenceMs,
    maxMs: raw.maxMs ?? DEFAULTS.maxMs,
    startTimeoutMs: raw.startTimeoutMs ?? DEFAULTS.startTimeoutMs,
    minSpeechMs: raw.minSpeechMs ?? DEFAULTS.minSpeechMs,
    vadThreshold: raw.vadThreshold ?? DEFAULTS.vadThreshold,
    toggle: raw.toggle ?? DEFAULTS.toggle,
    debug: raw.debug ?? DEFAULTS.debug,
  }
}

export function peakOf(chunk: Uint8Array): number {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  let peak = 0
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const sample = Math.abs(view.getInt16(i, true)) / 32768
    if (sample > peak) peak = sample
  }
  return peak
}

export function wavFromPcm(pcm: Uint8Array): Buffer<ArrayBuffer> {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export interface Capture {
  wav: Buffer
  voicedMs: number
  loudest: number
  hadSpeech: boolean
}

// --- utterance-endpointing state machine (per 50 ms tick) ---

export interface VadState {
  spoken: boolean
  voicedMs: number
  loudest: number
  quietFor: number
  elapsed: number
  done: boolean
  doneReason: string | null
}

export function initialVadState(): VadState {
  return { spoken: false, voicedMs: 0, loudest: 0, quietFor: 0, elapsed: 0, done: false, doneReason: null }
}

export function vadStep(state: VadState, peak: number, opts: RequiredVoiceOptions): VadState {
  if (state.done) return state
  const next: VadState = { ...state, elapsed: state.elapsed + TICK_MS }
  const finish = (reason: string): VadState => ({ ...next, done: true, doneReason: reason })

  if (peak > opts.vadThreshold) {
    next.voicedMs += TICK_MS
    if (peak > next.loudest) next.loudest = peak
    next.quietFor = 0
    next.spoken = true
  } else if (next.spoken) {
    next.quietFor += TICK_MS
    // Toggle mode: pauses are thinking time — only manual stop or max cap ends it.
    if (!opts.toggle && next.quietFor >= opts.silenceMs) return finish("silence")
  } else if (next.elapsed >= opts.startTimeoutMs) {
    return finish("start-timeout")
  }

  if (next.elapsed >= opts.maxMs) return finish("max-length")
  return next
}

/** Enough voiced audio to be worth transcribing (noise must not reach Whisper). */
export function hadSpeech(state: VadState, opts: RequiredVoiceOptions): boolean {
  return state.spoken && state.voicedMs >= opts.minSpeechMs
}

export function sttEndpoint(base: string): string {
  const trimmed = base.replace(/\/+$/, "")
  return trimmed.includes("/audio/transcriptions") ? trimmed : `${trimmed}/audio/transcriptions`
}
