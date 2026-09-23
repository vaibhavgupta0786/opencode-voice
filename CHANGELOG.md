# Changelog

## Unreleased

- Mic status indicator in the prompt footer (idle / recording / transcribing).
- Large editable dialog for transcripts (Cmd+Enter sends, Esc discards).

## v0.1.0

- Toggle dictation: `f9` starts, `f9` stops; pauses never end the take.
- Local-only transcription via any OpenAI-compatible STT endpoint.
- Edit-before-send dialog prefilled with the transcript.
- Unit tests (VAD, WAV, options) + CI (test, typecheck, binary checksums).
