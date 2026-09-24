import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  RATE,
  TICK_MS,
  hadSpeech,
  initialVadState,
  mergeOptions,
  peakOf,
  sttEndpoint,
  vadStep,
  wavFromPcm,
  type Capture,
  type VoiceOptions,
} from "./logic.ts"

// ---------------------------------------------------------------------------
// opencode-voice: local-only push-to-talk for OpenCode v2.
// f9 (or the mic in the prompt footer) -> record -> local whisper STT ->
// large editable dialog (Cmd+Enter sends, Esc discards) -> current session.
// No cloud, no temp audio files, no auto-send, no permission answering.
// ---------------------------------------------------------------------------

type Phase = "idle" | "recording" | "transcribing"

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

/** Record one utterance. Audio stays in memory.
 * Returns the capture promise plus a stop handle for toggle mode. */
function capture(
  opts: ReturnType<typeof mergeOptions>,
  log: (m: string) => void,
): { done: Promise<Capture>; stop: () => void } {
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
    const chunks: Uint8Array[] = []
    let state = initialVadState()
    let finished = false
    let errorText = ""
    let leftover: Uint8Array = new Uint8Array(0)

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
        if (peak > opts.vadThreshold) state = { ...state, voicedMs: state.voicedMs + (leftover.length / (RATE * 2)) * 1000 }
      }
      if (raw.length === 0 && errorText.trim()) {
        reject(new Error(`recorder produced no audio: ${errorText.trim().slice(0, 200)}`))
        return
      }
      log(
        `capture ${reason} voiced=${Math.round(state.voicedMs)}ms loudest=${state.loudest.toFixed(3)} bytes=${raw.length}`,
      )
      resolve({ wav: wavFromPcm(raw), voicedMs: state.voicedMs, loudest: state.loudest, hadSpeech: hadSpeech(state, opts) })
    }

    child.stdout?.on("data", (data: Buffer) => {
      if (finished) return
      chunks.push(data)
      let buf: Uint8Array = leftover.length > 0 ? Buffer.concat([leftover, data]) : data
      const window = Math.floor((RATE * 2 * TICK_MS) / 1000)
      while (buf.length >= window && !finished) {
        state = vadStep(state, peakOf(buf.subarray(0, window)), opts)
        buf = buf.subarray(window)
        if (state.done) finish(state.doneReason ?? "vad")
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
      if (!finished && state.elapsed >= opts.maxMs + 5000) finish("watchdog")
    }, 500)
    stopFn = () => finish("manual-stop")
  })
  return { done, stop: () => stopFn() }
}

async function transcribe(wav: Uint8Array, opts: ReturnType<typeof mergeOptions>): Promise<string> {
  const form = new FormData()
  form.append("model", opts.model)
  // Copy into a fresh ArrayBuffer-backed view: BlobPart rejects SharedArrayBuffer views.
  form.append("file", new Blob([Buffer.from(wav)], { type: "audio/wav" }), "utterance.wav")
  const response = await fetch(sttEndpoint(opts.stt), { method: "POST", body: form })
  if (!response.ok) throw new Error(`STT HTTP ${response.status} ${response.statusText}`)
  const body = (await response.json()) as { text?: string }
  return (body.text ?? "").trim()
}

export default Plugin.define({
  id: "voice",
  setup(ctx) {
    // TODO: wire debug to plugin options once discovery supports them.
    const opts = { ...mergeOptions(ctx.options as VoiceOptions | undefined), debug: true }
    const log = (m: string) => dbg(opts.debug, m)
    // Draft: takes pile up here until explicitly sent. Lets you build a
    // whole context over several takes, then review + send once.
    // (Lives in the render closure below, next to its display signal.)
    // Toggle state: f9 while recording stops the take instead of starting one.
    let stopActive: (() => void) | null = null

    // One footer slot owns everything: the live mic indicator plus the
    // global keymap (layers need a component owner, the slot provides it).
    return ctx.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const [phase, setPhase] = createSignal<Phase>("idle")
        let draft = ""
        const [takes, setTakes] = createSignal(0)
        let editorOpen = false

        const dictate = async () => {
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
          setPhase("recording")
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
            setPhase("idle")
            const message = error instanceof Error ? error.message : String(error)
            log(`capture failed: ${message}`)
            ctx.ui.toast.show({ title: "Voice", message: `Mic failed: ${message}`, variant: "error" })
            return
          }
          stopActive = null
          if (!audio.hadSpeech) {
            setPhase("idle")
            ctx.ui.toast.show({ message: "Heard nothing — try again.", variant: "warning" })
            return
          }
          setPhase("transcribing")
          const sttStarted = Date.now()
          let text: string
          try {
            text = await transcribe(audio.wav, opts)
          } catch (error) {
            setPhase("idle")
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
            setPhase("idle")
            ctx.ui.toast.show({ message: "Empty transcription — try again.", variant: "warning" })
            return
          }
          log(`transcript="${text}"`)
          log(`timing audio=${Math.round(audio.voicedMs)}ms stt=${Date.now() - sttStarted}ms bytes=${audio.wav.length}`)
          setPhase("idle")
          if (!opts.accumulate) {
            openEditor(sessionID, text)
            return
          }
          draft = draft ? `${draft}\n\n${text}` : text
          setTakes(takes() + 1)
          log(`draft take=${takes()} chars=${draft.length}`)
          // Single dialog model: every take lands in the draft editor, which
          // always shows all takes. Reopen if a stale editor is still up.
          if (editorOpen) ctx.ui.dialog.clear()
          openEditor(sessionID, draft, () => {
            draft = ""
            setTakes(0)
          })
        }

        const openSendDialog = () => {
          const route = ctx.ui.router.current()
          if (route.type !== "session") {
            ctx.ui.toast.show({ message: "Open a session first.", variant: "warning" })
            return
          }
          if (!draft.trim()) {
            ctx.ui.toast.show({ message: "Draft is empty — dictate with f9 first.", variant: "warning" })
            return
          }
          if (editorOpen) return // already reviewing
          openEditor(route.sessionID, draft, () => {
            draft = ""
            setTakes(0)
          })
        }

        const clearDraft = () => {
          if (editorOpen) {
            editorOpen = false
            ctx.ui.dialog.clear()
          }
          if (!draft) {
            ctx.ui.toast.show({ message: "Draft is already empty.", variant: "info" })
            return
          }
          draft = ""
          setTakes(0)
          ctx.ui.toast.show({ message: "Voice draft cleared.", variant: "info" })
        }

        // Large editable dialog. Ctrl+Enter sends, Esc closes keeping the draft.
        // One flag tracks it so a new take reopens (never stacks) the editor.
        const openEditor = (sessionID: string, initial: string, afterSend?: () => void) => {
          let edited = initial
          let sent = false
          let area: { plainText: string } | undefined
          const finish = (value: string) => {
            if (sent || !value.trim()) return
            sent = true
            editorOpen = false
            ctx.ui.dialog.clear()
            void ctx.client.session.prompt({ sessionID, text: value.trim() })
            afterSend?.()
          }
          const cancel = () => {
            editorOpen = false
            ctx.ui.dialog.clear()
          }
          editorOpen = true
          ctx.ui.dialog.set({ size: "large", centered: true })
          ctx.ui.dialog.show(() => (
            <box flexDirection="column" gap={1} padding={1}>
              <text>🎤 Voice draft — edit, Ctrl+Enter to send, Esc to keep</text>
              <textarea
                initialValue={initial}
                focused
                keyBindings={[{ name: "return", ctrl: true, action: "submit" }]}
                ref={(el: unknown) => {
                  area = el as { plainText: string }
                }}
                onContentChange={(value: unknown) => {
                  if (typeof value === "string") edited = value
                }}
                onSubmit={() => finish(area?.plainText ?? edited)}
                onKeyDown={(event: unknown) => {
                  const name = (event as { name?: string } | null)?.name
                  if (name === "escape") cancel()
                }}
              />
            </box>
          ))
        }

        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "voice.dictate",
              title: "Dictate prompt (voice)",
              description: "Record one utterance, transcribe locally, add to the draft.",
              group: "Voice",
              bind: "f9",
              palette: true,
              slash: { name: "dictate" },
              run: () => dictate(),
            },
            {
              id: "voice.send",
              title: "Review voice draft",
              description: "Open the draft editor (all takes). Ctrl+Enter sends, Esc keeps.",
              group: "Voice",
              bind: "<leader>v",
              palette: true,
              slash: { name: "voice-send" },
              run: () => openSendDialog(),
            },
            {
              id: "voice.clear",
              title: "Clear voice draft",
              description: "Discard the accumulated draft without sending.",
              group: "Voice",
              bind: "<leader>V",
              palette: true,
              slash: { name: "voice-clear" },
              run: () => clearDraft(),
            },
          ],
          bindings: ["voice.dictate", "voice.send", "voice.clear"],
        }))

        const label = () => {
          const p = phase()
          if (p === "recording") return "🔴 REC f9"
          if (p === "transcribing") return "🟡 …"
          const n = takes()
          return n > 0 ? `🎤·${n} f9` : "🎤 f9"
        }
        return <text>{label()}</text>
      },
    })
  },
})
