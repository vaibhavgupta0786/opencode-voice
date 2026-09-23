# opencode-voice

Local-only push-to-talk dictation for [OpenCode](https://opencode.ai) v2.
Press `f9`, talk (pauses welcome), press `f9` again — the transcript lands
in an edit dialog, then goes to your session.

No cloud, no temp audio files, no auto-send, no permission answering.

## Install

Requirements: OpenCode v2, a local STT server (see `docs/STT.md`),
macOS Microphone permission for your terminal.

```sh
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/vaibhavgupta0786/opencode-voice ~/.config/opencode/plugins/voice
# restart the OpenCode TUI, open a session, press f9
```

`f9` may be hijacked by macOS Fn keys — `Ctrl+P` → `dictate` (or
`/dictate`) works the same.

## Usage

| Input | Action |
|---|---|
| `f9` | start recording ("Recording… f9 to stop.") |
| `f9` again | stop → transcribe → edit dialog → send |
| `/dictate` | same, via slash command / palette |

After transcribing, a large edit dialog opens with the full text.
`Ctrl+Enter` sends to the current session (`Cmd+Enter` also works where the
terminal delivers it), `Esc` discards.
A mic indicator lives in the prompt footer: 🎤 idle, 🔴 recording, 🟡 transcribing.
Takes cap at 60 s. Debug log: `/tmp/opencode/voice-plugin.log`.

## How it works

```
f9 -> bundled mic recorder (16 kHz PCM, stdout, in memory)
   -> silence/VAD state machine (toggle: pauses never end the take)
   -> POST WAV to local whisper at 127.0.0.1:8080
   -> edit dialog -> session.prompt
```

See `docs/STT.md` (server + model choice) and `docs/TROUBLESHOOTING.md`.

## Development

```sh
npm ci
npm test        # 12 unit tests, no mic needed
npm run typecheck
```

Pure logic in `logic.ts`, host/IO in `tui.ts`. See `CONTRIBUTING.md`.

## Recorder binaries

`bin/` ships prebuilt mic recorders built from
[opencode-dictate](https://github.com/rodri45l/opencode-dictate)'s
`recorder/recorder.c` (miniaudio, MIT) — see NOTICE. SHA256 pinned in
`bin/SHA256SUMS` and verified in CI. To rebuild from source, fetch
`recorder.c` + `miniaudio.h` upstream and compile, e.g. on macOS:
`cc -O2 -o recorder recorder.c -framework CoreAudio -framework AudioToolbox -framework CoreFoundation`.

## Roadmap

- 🎤 mic button in the prompt footer
- Voice-out: spoken digest of long replies (not verbatim readout) + local TTS

## License

MIT — see LICENSE.
