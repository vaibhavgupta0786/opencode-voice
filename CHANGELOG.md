# Changelog

## Unreleased

- Draft accumulation: takes pile into a draft; one review, one send.
  - `F9` takes, `F10` opens the draft editor, `F11` wipes it.
  - Editor opens after every take showing all takes; Ctrl+Enter sends, Esc keeps.
- Mic status indicator in the prompt footer (idle / recording / transcribing).
- Large editable dialog for transcripts (Ctrl+Enter sends, Esc keeps).
- mlx-whisper GPU server (`servers/mlx_server.py`, ~2–3s per take).

## v0.1.0

- Toggle dictation: `f9` starts, `f9` stops; pauses never end the take.
- Local-only transcription via any OpenAI-compatible STT endpoint.
- Edit-before-send dialog prefilled with the transcript.
- Unit tests (VAD, WAV, options) + CI (test, typecheck, binary checksums).
