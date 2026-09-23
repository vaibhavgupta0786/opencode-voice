import { Plugin } from "@opencode/plugin/tui"
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// opencode-voice: minimal local-only push-to-talk for OpenCode v2.
// f9 -> record mic -> transcribe via local whisper server -> edit in dialog
//     -> send to current session. No cloud, no temp audio files, no
//     auto-send, no permission answering.
// ---------------------------------------------------------------------------

const RATE = 16_000 // recorder streams 16-bit mono PCM at 16 kHz

interface VoiceOptions {
  stt?: string // base URL of OpenAI-compatible STT, default below
  model?: string // STT model name, default "whisper-1"
  silenceMs?: number // quiet time ending the utterance (default 900)
  maxMs?: number // hard cap per utterance (default 60_000)
  startTimeoutMs?: number // give up if silent this long (default 4_000)
  minSpeechMs?: number // voiced audio required (default 300)
  vadThreshold?: number // peak amplitude counting as voice (default 0.03)
  toggle?: boolean // f9 starts, f9 stops; pauses never end the take (default true)
  debug?: boolean
}

const DEFAULTS = {
  stt: "http://127.0.0.1:8080/v1",
  model: "whisper-1",
  silenceMs: 900,
  maxMs: 60_000,
  startTimeoutMs: 4_000,
  minSpeechMs: 300,
  vadThreshold: 0.03,
} as const

const HANGOVER_MS = 350 // pauses shorter than this are not "finished"
const DEBUG_LOG = "/tmp/opencode/voice-plugin.log"

function dbg(enabled: boolean, message: string): void {
  if (!enabled) return
  try {
    mkdirSync("/tmp/opencode", { recursive: true })
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // logging must never break dictation
  }
}

function here(): string {
  try {
    return join(fileURLToPath(new URL(".", import.meta.url)))
  } catch {
    return join(process.env.HOME ?? "~", ".config", "opencode", "plugins", "voice")
  }
}

/** Bundled mic recorder (audited source: miniaudio, streams raw PCM to stdout). */
function recorderPath(): string | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null
  if (!os) return null
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const path = join(here(), "bin", `${os}-${arch}`, "opencode-voice-recorder")
  return existsSync(path) ? path : null
}

function peakOf(chunk: Buffer): number {
  let peak = 0
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const sample = Math.abs(chunk.readInt16LE(i)) / 32768
    if (sample > peak) peak = sample
  }
  return peak
}

interface Capture {
  wav: Buffer
  voicedMs: number
  loudest: number
  hadSpeech: boolean
}

function wavFromPcm(pcm: Buffer): Buffer {
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

/** Record one utterance. Audio stays in memory.
 * Returns the capture promise plus a stop handle for toggle mode. */
function capture(opts: Required<VoiceOptions>, log: (m: string) => void): { done: Promise<Capture>; stop: () => void } {
  const cmd = recorderPath()
  if (!cmd)
    return {
      done: Promise.reject(new Error("no bundled recorder for this platform")),
      stop: () => {},
    }
  const maxSec = Math.ceil(opts.maxMs / 1000).toFixed(0)

  let stopFn: () => void = () => {}
  const done = new Promise<Capture>((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, ["--seconds", maxSec, "--gain", "1.00"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks: Buffer[] = []
    let voicedMs = 0
    let loudest = 0
    let quietFor = 0
    let elapsed = 0
    let spoken = false
    let finished = false
    let errorText = ""
    let leftover = Buffer.alloc(0)
    const TICK_MS = 50 // evaluate VAD in 50 ms windows (1600 bytes)

    const finish = (reason: string) => {
      if (finished) return
      finished = true
      stopFn = () => {}
      clearInterval(timer)
      try {
        child.kill("SIGKILL")
      } catch {
        // already exited
      }
      const raw = Buffer.concat(chunks)
      if (leftover.length > 0) {
        // account for a trailing partial window
        const peak = peakOf(leftover)
        if (peak > opts.vadThreshold) voicedMs += (leftover.length / (RATE * 2)) * 1000
      }
      if (raw.length === 0 && errorText.trim()) {
        reject(new Error(`recorder produced no audio: ${errorText.trim().slice(0, 200)}`))
        return
      }
      const hadSpeech = spoken && voicedMs >= opts.minSpeechMs
      log(`capture ${reason} voiced=${Math.round(voicedMs)}ms loudest=${loudest.toFixed(3)} bytes=${raw.length}`)
      resolve({ wav: wavFromPcm(raw), voicedMs, loudest, hadSpeech })
    };

    const step = (peak: number, tickMs: number) => {
      elapsed += tickMs
      if (peak > opts.vadThreshold) {
        voicedMs += tickMs
        if (peak > loudest) loudest = peak
        quietFor = 0
        spoken = true
      } else if (spoken) {
        quietFor += tickMs
        // Toggle mode: pauses are thinking time — only a manual stop (or the
        // max-length cap) ends the take. Auto mode keeps silence endpointing.
        if (!opts.toggle && quietFor >= opts.silenceMs) finish("silence")
      } else if (elapsed >= opts.startTimeoutMs) {
        finish("start-timeout")
      }
      if (elapsed >= opts.maxMs) finish("max-length")
    };

    child.stdout?.on("data", (data: Buffer) => {
      if (finished) return
      chunks.push(data)
      let buf = leftover.length > 0 ? Buffer.concat([leftover, data]) : data
      const window = Math.floor((RATE * 2 * TICK_MS) / 1000)
      while (buf.length >= window && !finished) {
        step(peakOf(buf.subarray(0, window)), TICK_MS)
        buf = buf.subarray(window)
      }
      leftover = buf
    })
    child.stderr?.on("data", (data: Buffer) => {
      if (errorText.length < 2048) errorText += data.toString()
    })
    child.on("error", (error) => {
      if (!finished) {
        finished = true
        clearInterval(timer)
        reject(error)
      }
    })
    child.on("close", () => finish("recorder-exit"))
    // Failsafe: never hold the mic forever.
    const timer = setInterval(() => {
      if (!finished && elapsed >= opts.maxMs + 5000) finish("watchdog")
    }, 500)
    stopFn = () => finish("manual-stop")
  })
  return { done, stop: () => stopFn() }
}

async function transcribe(wav: Buffer, opts: Required<VoiceOptions>): Promise<string> {
  const base = opts.stt.replace(/\/+$/, "")
  const url = base.includes("/audio/transcriptions") ? base : `${base}/audio/transcriptions`
  const form = new FormData()
  form.append("model", opts.model)
  form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav")
  const response = await fetch(url, { method: "POST", body: form })
  if (!response.ok) throw new Error(`STT HTTP ${response.status} ${response.statusText}`)
  const body = (await response.json()) as { text?: string }
  return (body.text ?? "").trim()
}

export default Plugin.define({
  id: "voice",
  setup(ctx) {
    const raw = (ctx.options ?? {}) as VoiceOptions
    const opts: Required<VoiceOptions> = {
      stt: raw.stt ?? DEFAULTS.stt,
      model: raw.model ?? DEFAULTS.model,
      silenceMs: raw.silenceMs ?? DEFAULTS.silenceMs,
      maxMs: raw.maxMs ?? DEFAULTS.maxMs,
      startTimeoutMs: raw.startTimeoutMs ?? DEFAULTS.startTimeoutMs,
      minSpeechMs: raw.minSpeechMs ?? DEFAULTS.minSpeechMs,
      vadThreshold: raw.vadThreshold ?? DEFAULTS.vadThreshold,
      toggle: raw.toggle ?? true,
      debug: true, // TODO: wire to plugin options once discovery supports them
    }
    const log = (m: string) => dbg(opts.debug, m)
    // Toggle state: f9 while recording stops the take instead of starting one.
    let stopActive: (() => void) | null = null

    // Keymap layers need a component owner: register inside the `app` slot.
    // Returning the slot cleanup from setup unregisters everything on unload.
    return ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "voice.dictate",
          title: "Dictate prompt (voice)",
          description: "Record one utterance, transcribe locally, edit, then send.",
          group: "Voice",
          bind: "f9",
          palette: true,
          slash: { name: "dictate" },
          run: async () => {
            const route = ctx.ui.router.current()
            if (route.type !== "session") {
              ctx.ui.toast.show({ message: "Open a session first, then dictate.", variant: "warning" })
              return
            }
            // Second f9 while recording: stop the take, transcription follows.
            if (stopActive) {
              ctx.ui.toast.show({ message: "Stopped — transcribing…", variant: "info", duration: 2000 })
              log("manual stop")
              const stop = stopActive
              stopActive = null
              stop()
              return
            }
            const sessionID = route.sessionID
            ctx.ui.toast.show({
              message: opts.toggle ? "Recording… f9 to stop." : "Listening… speak now.",
              variant: "info",
              duration: 2000,
            })
            log("dictate started")
            const cap = capture(opts, log)
            stopActive = cap.stop
            let audio: Capture
            try {
              audio = await cap.done
            } catch (error) {
              stopActive = null
              const message = error instanceof Error ? error.message : String(error)
              log(`capture failed: ${message}`)
              ctx.ui.toast.show({ title: "Voice", message: `Mic failed: ${message}`, variant: "error" })
              return
            }
            stopActive = null
            const hadSpeech = audio.hadSpeech
            if (!hadSpeech) {
              ctx.ui.toast.show({ message: "Heard nothing — try again.", variant: "warning" })
              return
            }
            ctx.ui.toast.show({ message: "Transcribing…", variant: "info", duration: 2000 })
            let text: string
            try {
              text = await transcribe(audio.wav, opts)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              log(`transcribe failed: ${message}`)
              ctx.ui.toast.show({
                title: "Voice",
                message: `STT failed (${message}). Is the local server up?`,
                variant: "error",
              })
              return
            }
            if (!text) {
              ctx.ui.toast.show({ message: "Empty transcription — try again.", variant: "warning" })
              return
            }
            log(`transcript="${text}"`)
            const edited = await ctx.ui.dialog.prompt({ title: "Dictation", value: text })
            if (edited === undefined || !edited.trim()) return // cancelled
            await ctx.client.session.prompt({ sessionID, text: edited.trim() })
          },
        },
      ],
      bindings: ["voice.dictate"],
    }))
        // No visible UI: the slot exists only to own the keymap layer.
        return null
      },
    })
  },
})
