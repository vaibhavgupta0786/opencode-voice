# opencode-voice

Local-only push-to-talk dictation for OpenCode v2.

`f9` starts recording, `f9` stops. The take is transcribed by a local
whisper server, shown in an edit dialog, then sent to the current session.

## How it works

```
f9 -> bundled mic recorder (16 kHz PCM, in memory, no files)
   -> POST to local STT at http://127.0.0.1:8080/v1/audio/transcriptions
   -> edit dialog prefilled with the transcript
   -> send to current session
```

- No cloud, no temp audio files, no auto-send, no permission answering.
- Toggle mode: pauses never end the take (thinking time is safe).
- 60 s hard cap per take.

## Requirements

- OpenCode v2 (TUI plugin API `@opencode/plugin/tui`)
- A local OpenAI-compatible STT server on `127.0.0.1:8080`
  (e.g. faster-whisper: `WHISPER_MODEL=small python server.py`)
- macOS microphone permission for your terminal

## Install (local)

```sh
mkdir -p ~/.config/opencode/plugins
cp -r voice ~/.config/opencode/plugins/voice
# restart the OpenCode TUI, press f9
```

## Recorder binaries

`bin/` ships prebuilt mic recorders. They are built from
[opencode-dictate](https://github.com/rodri45l/opencode-dictate)'s
`recorder/recorder.c` (miniaudio, MIT-licensed) — see NOTICE.
Rebuild: `cc -O2 -o bin/darwin-arm64/opencode-voice-recorder recorder.c
-framework CoreAudio -framework AudioToolbox -framework CoreFoundation`
(source not vendored here; fetch it from the link above).

## License

MIT — see LICENSE.
