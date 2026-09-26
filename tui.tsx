import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
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
//   F9  — dictate a take (press to start, press to stop); takes append to
//         that session's draft
//   F10 — open the session's draft editor (any time, empty or not);
//         Ctrl+Enter sends, Esc keeps edits
//   F12 — wipe the session's draft (confirmation dialog)
// Each session keeps its own draft, so switching chats never mixes them.
// On MacBooks press F-keys with Fn: plain F10 is the hardware mic-mute key,
// plain F11 is Show Desktop (macOS reserves it), so review/wipe use F10/F12.
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

/** Path of the voice-check skill if installed in the user's global skills
 * dir (skills are only discovered from there, not from plugin packages). */
function installedSkillPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(configHome, "opencode", "skills", "voice-check", "SKILL.md")
}

/** Install the bundled voice-check skill into the user's global skills dir
 * (once — an existing file is never overwritten, so user edits survive).
 * Only ever called from the explicit voice-setup command: a plugin package
 * silently writing to global config on load would be exactly the kind of
 * behavior a careful developer audits for. */
function installSkill(log: (m: string) => void): "installed" | "exists" | "missing-source" | "error" {
  try {
    const target = installedSkillPath()
    if (existsSync(target)) return "exists"
    const source = join(here(), "skills", "voice-check", "SKILL.md")
    if (!existsSync(source)) return "missing-source"
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, readFileSync(source))
    log("installed voice-check skill globally")
    return "installed"
  } catch {
    // a skill install must never break dictation
    return "error"
  }
}

/** Record one utterance. Audio stays in memory.
 * Returns the capture promise plus a stop handle for toggle mode.
 * `shouldAbort` is polled every 500 ms: the moment it reports true the
 * recorder is killed and the take is discarded ("take-aborted"). */
function capture(
  opts: ReturnType<typeof mergeOptions>,
  log: (m: string) => void,
  shouldAbort?: () => boolean,
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
    // Failsafe: never hold the mic forever. Also aborts the take the
    // moment the user switches away from the session it belongs to
    // (checked every 500 ms).
    const timer = setInterval(() => {
      if (finished) return
      if (shouldAbort?.()) {
        finished = true
        stopFn = () => {}
        clearInterval(timer)
        try {
          child.kill("SIGKILL")
        } catch {
          // already exited
        }
        log("capture aborted — session switched mid-recording")
        reject(new Error("take-aborted"))
        return
      }
      if (state.elapsed >= opts.maxMs + 5000) finish("watchdog")
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

/** Display width of text — cursorOffset is measured in width units (host does
 * the same via Bun.stringWidth); plain UTF-16 length is the ASCII fallback. */
function displayWidth(text: string): number {
  const bun = (globalThis as { Bun?: { stringWidth?: (s: string) => number } }).Bun
  return bun?.stringWidth ? bun.stringWidth(text) : text.length
}

// One session's draft.
interface DraftState {
  text: string
  takes: number
}

const EMPTY_DRAFT: DraftState = { text: "", takes: 0 }

export default Plugin.define({
  id: "voice",
  setup(ctx) {
    // TODO: wire debug to plugin options once discovery supports them.
    const opts = { ...mergeOptions(ctx.options as VoiceOptions | undefined), debug: true }
    const log = (m: string) => dbg(opts.debug, m)

    // --- plugin-scope state -------------------------------------------------
    // Per-session drafts, kept at setup scope: switching sessions remounts
    // the prompt footer (render-scoped state would reset), and each session
    // must keep its own draft anyway. Keyed by sessionID.
    const [phase, setPhase] = createSignal<Phase>("idle")
    const [drafts, setDrafts] = createSignal<Record<string, DraftState>>({})
    const draftOf = (sessionID: string): DraftState => drafts()[sessionID] ?? EMPTY_DRAFT
    const putDraft = (sessionID: string, patch: Partial<DraftState>): void => {
      setDrafts({ ...drafts(), [sessionID]: { ...draftOf(sessionID), ...patch } })
    }
    // Toggle state: f9 while recording stops the take instead of starting one.
    let stopActive: (() => void) | null = null

    interface ActiveEditor {
      getContent: () => string
      /** Session whose draft this editor edits. */
      sessionID: string
    }
    let active: ActiveEditor | null = null

    const persistActive = (): void => {
      if (!active) return
      const sessionID = active.sessionID
      const content = active.getContent()
      if (content.trim()) {
        putDraft(sessionID, { text: content })
        log(`persisted editor edits session=${sessionID} chars=${content.length}`)
      } else {
        putDraft(sessionID, { text: "", takes: 0 })
      }
    }

    const dictate = async () => {
      // Second f9 while recording: stop the take, transcription follows.
      if (stopActive) {
        ctx.ui.toast.show({ message: "Stopped — transcribing…", variant: "info", duration: 2000 })
        log("manual stop")
        const stop = stopActive
        stopActive = null
        stop()
        return
      }
      // Never overlap a second recording onto an in-flight transcription.
      if (phase() === "transcribing") {
        ctx.ui.toast.show({ message: "Still transcribing — one moment.", variant: "warning", duration: 2000 })
        return
      }
      const route = ctx.ui.router.current()
      let sessionID: string
      if (route.type === "session") {
        sessionID = route.sessionID
      } else if (route.type === "home") {
        // A brand-new blank session renders the home/launch route.
        // Dictating there starts the session, exactly like typing a
        // prompt on the launch view would.
        try {
          const created = await ctx.client.session.create({})
          sessionID = created.id
          ctx.ui.router.navigate({ type: "session", sessionID })
          log(`created session ${sessionID} for dictation`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`session create failed: ${message}`)
          ctx.ui.toast.show({
            title: "Voice",
            message: `Could not start a session: ${message}`,
            variant: "error",
          })
          return
        }
      } else {
        ctx.ui.toast.show({ message: "Open a session first, then dictate.", variant: "warning" })
        return
      }
      // New take from inside the editor: persist edits, close it, record.
      if (active) {
        persistActive()
        active = null
        ctx.ui.dialog.clear()
      }
      setPhase("recording")
      ctx.ui.toast.show({
        message: opts.toggle ? "Recording… f9 to stop." : "Listening… speak now.",
        variant: "info",
        duration: 2000,
      })
      log("dictate started")
      // Discard the take if the user switches away from its session: checked
      // while recording (500 ms ticks), after stop (before STT), and after
      // STT. Only the take is discarded — every draft stays untouched.
      const switchedAway = (): boolean => {
        const r = ctx.ui.router.current()
        return r.type !== "session" || r.sessionID !== sessionID
      }
      const cap = capture(opts, log, switchedAway)
      stopActive = cap.stop
      let audio: Capture
      try {
        audio = await cap.done
      } catch (error) {
        stopActive = null
        setPhase("idle")
        const message = error instanceof Error ? error.message : String(error)
        if (message === "take-aborted") {
          ctx.ui.toast.show({
            message: "Take discarded — you switched chats mid-recording.",
            variant: "warning",
            duration: 3000,
          })
          return
        }
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
      // Checkpoint: switched between stop and transcription — skip the STT
      // upload entirely.
      if (switchedAway()) {
        setPhase("idle")
        log("discarded take — session switched before transcription")
        ctx.ui.toast.show({ message: "Take discarded — you switched chats.", variant: "warning", duration: 3000 })
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
          message: existsSync(installedSkillPath())
            ? `STT failed (${message}) — run /voice-check to restart the server.`
            : `STT failed (${message}) — run /voice-setup once, then /voice-check.`,
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
      // Checkpoint: switched during transcription — the transcript is
      // discarded, never appended to any draft.
      if (switchedAway()) {
        setPhase("idle")
        log("discarded transcript — session switched during transcription")
        ctx.ui.toast.show({ message: "Take discarded — you switched chats.", variant: "warning", duration: 3000 })
        return
      }
      setPhase("idle")
      if (!opts.accumulate) {
        openEditor(sessionID, text, false)
        return
      }
      const current = draftOf(sessionID)
      const merged = current.text ? `${current.text}\n\n${text}` : text
      putDraft(sessionID, { text: merged, takes: current.takes + 1 })
      log(`draft session=${sessionID} take=${current.takes + 1} chars=${merged.length}`)
      openEditor(sessionID, merged, true)
    }

    const openSendDialog = () => {
      const route = ctx.ui.router.current()
      if (route.type !== "session") {
        ctx.ui.toast.show({ message: "Open a session first.", variant: "warning" })
        return
      }
      // Fold in edits from an editor the host may have closed itself.
      persistActive()
      const sessionID = route.sessionID
      // Open the editor even when this session's draft is empty: it doubles
      // as a place to compose by hand and then send.
      openEditor(sessionID, draftOf(sessionID).text, true)
    }

    // F12 wipes the draft of the session being viewed.
    const clearDraft = async () => {
      const hadEditor = active !== null
      const editorSession = active?.sessionID
      if (active) {
        persistActive()
        active = null
        ctx.ui.dialog.clear()
      }
      const route = ctx.ui.router.current()
      if (route.type !== "session") {
        ctx.ui.toast.show({ message: "Open a session first.", variant: "warning" })
        return
      }
      const sessionID = route.sessionID
      const current = draftOf(sessionID)
      if (!current.text.trim()) {
        ctx.ui.toast.show({ message: "Draft is already empty.", variant: "info" })
        return
      }
      const confirmed = await ctx.ui.dialog.confirm({
        title: "Wipe voice draft?",
        message: `Discard this session's draft (${current.text.length} chars)? This cannot be undone.`,
        label: { confirm: "Wipe draft", cancel: "Keep it" },
      })
      if (confirmed === true) {
        putDraft(sessionID, { text: "", takes: 0 })
        ctx.ui.dialog.clear()
        ctx.ui.toast.show({ message: "Voice draft wiped.", variant: "info" })
        return
      }
      // Kept: if we closed this session's editor for the confirm, reopen it
      // exactly as it was (edits were persisted before the confirm appeared).
      if (hadEditor && editorSession === sessionID) {
        openEditor(sessionID, draftOf(sessionID).text, true)
      }
    }

    // --- editor --------------------------------------------------------------
    // One dialog, idempotent. Opening always clears any previous dialog and
    // shows the text with the cursor at the end; the textarea is height-
    // capped like the host's own prompt, so long drafts scroll internally
    // and the cursor stays visible.
    const openEditor = (sessionID: string, initial: string, persistDraft: boolean) => {
      let edited = initial
      let sent = false
      let cursorPlaced = false
      let area: { plainText?: string; cursorOffset?: number } | undefined

      // Live-tracked content: prefer the renderable itself, fall back to
      // the onContentChange mirror (survives renderable destruction).
      const getContent = (): string => {
        try {
          const t = area?.plainText
          if (typeof t === "string") return t
        } catch {
          // destroyed renderable
        }
        return edited
      }

      const self: ActiveEditor = { getContent, sessionID }
      const header = persistDraft
        ? "🎤 Voice draft — edit · Ctrl+Enter send · Esc keep edits"
        : "🎤 Dictation — edit · Ctrl+Enter send · Esc cancel"

      const finish = async (value: string) => {
        if (sent || active !== self) return
        const text = value.trim()
        if (!text) {
          cancel()
          return
        }
        // Refuse to deliver to a session other than the one visible now.
        const route = ctx.ui.router.current()
        if (route.type !== "session" || route.sessionID !== sessionID) {
          ctx.ui.toast.show({
            title: "Voice",
            message: "Session changed — not sent. Draft kept.",
            variant: "warning",
          })
          return
        }
        sent = true
        if (persistDraft) putDraft(sessionID, { text }) // a failed send must not lose the latest text
        try {
          await ctx.client.session.prompt({ sessionID, text })
        } catch (error) {
          sent = false
          const message = error instanceof Error ? error.message : String(error)
          log(`send failed: ${message}`)
          ctx.ui.toast.show({
            title: "Voice",
            message: `Send failed: ${message} — draft kept, Ctrl+Enter to retry.`,
            variant: "error",
          })
          return // editor stays open; retry in place
        }
        active = null
        ctx.ui.dialog.clear()
        if (persistDraft) putDraft(sessionID, { text: "", takes: 0 })
      }

      const cancel = () => {
        if (active !== self) return
        if (persistDraft) persistActive()
        active = null
        ctx.ui.dialog.clear()
      }

      active = self
      ctx.ui.dialog.clear() // never stack editors
      ctx.ui.dialog.set({ size: "large", centered: true })
      // The host's own prompt caps its textarea the same way: bounded
      // height makes the editor scroll internally and keep the cursor
      // visible.
      const termRows = (process.stdout as { rows?: number }).rows ?? 40
      const maxHeight = Math.max(6, Math.floor(termRows * 0.5))
      ctx.ui.dialog.show(
        () => (
          <box flexDirection="column" gap={1} padding={1}>
            <text>{header}</text>
            <textarea
              width="100%"
              minHeight={1}
              maxHeight={maxHeight}
              initialValue={initial}
              focused
              keyBindings={[{ name: "return", ctrl: true, action: "submit" }]}
              ref={(el: unknown) => {
                area = el as { plainText?: string; cursorOffset?: number }
                // Cursor at the end: new takes land there and edits
                // usually continue at the tail of the draft. Deferred —
                // the host's own prompt mutates the textarea post-mount
                // the same way (the initialValue prop sync would otherwise
                // run after an immediate set and reset the cursor).
                if (!cursorPlaced) {
                  cursorPlaced = true
                  setTimeout(() => {
                    const el2 = area
                    if (!el2) return
                    try {
                      el2.cursorOffset = displayWidth(initial)
                    } catch {
                      // optional nicety, never fatal
                    }
                  }, 0)
                }
              }}
              onContentChange={(value: unknown) => {
                if (typeof value === "string") edited = value
              }}
              onSubmit={() => finish(getContent())}
              onKeyDown={(event: unknown) => {
                const name = (event as { name?: string } | null)?.name
                if (name === "escape") cancel()
              }}
            />
          </box>
        ),
        () => {
          // The host closed the dialog itself (Esc handled at the dialog
          // level): fold the edits into the draft so nothing is lost.
          if (active !== self) return
          if (persistDraft) persistActive()
          active = null
        },
      )
    }

    // One footer slot owns the visible parts: the live mic indicator plus
    // the global keymap (layers need a component owner, the slot provides
    // it). All state lives at setup scope above, so slot remounts (session
    // switches) never lose drafts; the take count shown is the visible
    // session's own.
    return ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
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
              description: "Open the session's draft editor (empty or not). Ctrl+Enter sends, Esc keeps.",
              group: "Voice",
              bind: "f10",
              palette: true,
              slash: { name: "voice-send" },
              run: () => openSendDialog(),
            },
            {
              id: "voice.clear",
              title: "Wipe voice draft",
              description: "Discard this session's draft (asks for confirmation).",
              group: "Voice",
              bind: "f12",
              palette: true,
              slash: { name: "voice-clear" },
              run: () => clearDraft(),
            },
            {
              id: "voice.setup",
              title: "Install voice-check recovery skill",
              description: "One-time opt-in: install the voice-check STT recovery skill globally.",
              group: "Voice",
              palette: true,
              slash: { name: "voice-setup" },
              run: () => {
                const result = installSkill(log)
                if (result === "installed") {
                  ctx.ui.toast.show({
                    title: "Voice",
                    message: "voice-check skill installed — type /voice-check or say 'voice is dead' any time.",
                    variant: "success",
                    duration: 5000,
                  })
                } else if (result === "exists") {
                  ctx.ui.toast.show({ message: "voice-check skill is already installed.", variant: "info" })
                } else {
                  ctx.ui.toast.show({
                    title: "Voice",
                    message: "Could not install the skill — see docs/STT.md for manual recovery.",
                    variant: "error",
                  })
                }
              },
            },
          ],
          bindings: ["voice.dictate", "voice.send", "voice.clear", "voice.setup"],
        }))

        const label = () => {
          const p = phase()
          if (p === "recording") return "🔴 REC f9"
          if (p === "transcribing") return "🟡 …"
          const sid = input.sessionID
          const n = sid ? (drafts()[sid]?.takes ?? 0) : 0
          return n > 0 ? `🎤·${n} f9` : "🎤 f9"
        }
        return <text>{label()}</text>
      },
    })
  },
})
