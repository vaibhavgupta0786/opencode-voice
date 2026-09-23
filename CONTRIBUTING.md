# Contributing

## Tests (no mic needed)

```sh
npm ci
npm test        # node built-in runner, test/*.test.ts
npm run typecheck
```

Pure logic lives in `logic.ts` (VAD, WAV, options) and is fully unit-tested.
`tui.ts` owns host/IO (mic, dialogs, session) and is verified manually:

1. Start the local STT server (see `docs/STT.md`).
2. Restart the OpenCode TUI, open any session.
3. `f9`, speak, `f9` again — transcript lands in an edit dialog.
4. Check `/tmp/opencode/voice-plugin.log` for the capture line.

## Sending a hardware-free take through the pipeline

To test transcription without a mic, POST a wav directly:

```sh
curl -F model=whisper-1 -F file=@sample.wav \
  http://127.0.0.1:8080/v1/audio/transcriptions
```

## Conventions

- Audio stays in memory; never write temp audio files.
- Network destinations: localhost STT only. No telemetry, no cloud calls.
- `CHANGELOG.md` entry for every user-visible change.
