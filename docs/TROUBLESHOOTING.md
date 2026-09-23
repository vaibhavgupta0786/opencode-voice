# Troubleshooting

Debug log (if enabled): `/tmp/opencode/voice-plugin.log`.
Every take logs one line:

```
capture <reason> voiced=700ms loudest=0.058 bytes=96000
transcript="..."
```

## `f9` does nothing at all

- The command needs a session open. Open one first.
- `f9` may be hijacked by macOS (Fn keys). Use `Ctrl+P` → `dictate`,
  or `/dictate`, instead.

## `voiced=0ms loudest=0.000` — pure silence

macOS Microphone permission. **System Settings → Privacy & Security →
Microphone** → enable your terminal app, then retry. (CoreAudio feeds
zeros when permission is denied — the recorder runs fine, the mic is muted.)

## `STT failed ... Is the local server up?`

- `curl http://127.0.0.1:8080/health` should return `{"status": "ok"}`.
- First start downloads the model (small ≈ 500 MB) — watch the server log
  for `ready` before dictating.

## Takes cut off mid-thought

Toggle mode (default) never ends on silence — only the second `f9` (or the
60 s cap) ends a take. If takes still split, you are on `toggle: false`;
either re-enable toggle or raise `silenceMs` (900 → 2500).

## Phantom / hallucinated transcripts

Whisper invents phrases ("Thank you.") from noise. The plugin drops takes
below `minSpeechMs` (default 300 ms) of voiced audio, but in a noisy room
raise `vadThreshold` (0.03 → 0.06). The log's `loudest=` shows your levels.

## Plugin shows "failed" in the sidebar

- `Cannot find package '@opencode/plugin'` (server): you have a stray
  server entrypoint importing it — this plugin is TUI-only by design.
- `Keymap.Provider is missing`: keymap registration must happen inside a
  component/slot render, not bare in `setup()`.
