# Changelog

## Unreleased

- Draft is plugin-wide state now: it survives session switches (previously
  the footer slot remounted on every chat switch and reset it).
- `F10` opens the editor even with an empty draft — it doubles as a place
  to compose by hand, then send.
- Cursor now starts at the end of the draft (deferred set, display-width
  units — the immediate ref-time set was reset by the initialValue prop sync).
- Dictating on a brand-new blank session (home/launch route) now starts the
  session and dictates into it, like typing a prompt there would — instead
  of refusing with "open a session first".
- The stop/transcribing guards now run before the session check, so a
  second `F9` always stops the take regardless of the current view.
- Editor rework — one dialog, robust draft lifecycle:
  - Esc (or any host-side close) now **keeps your edits** — they are folded
    back into the draft on every close path, not just our own Esc handler.
  - Fixed: review (`/voice-send`, then-F10) silently doing nothing after the
    host closed a previous editor (stale open-flag swallowed the command).
  - Long drafts scroll (the textarea is height-capped like the host's own
    prompt, so the editor scrolls internally and keeps the cursor visible —
    fixes "typing appears dead" once the draft exceeded the dialog).
  - A failed send keeps the draft and allows retrying in place; switching
    sessions with the editor open refuses to deliver to the wrong chat.
- Hotkeys re-bound on plain F-keys (leader chords never register from
  plugin layers): `F10` review, `F12` wipe — with a confirmation dialog.
- `F9` while a transcription is still in flight is blocked with a toast
  instead of overlapping a second recording.

## v0.1.x

- Draft accumulation: takes pile into a draft; one review, one send.
  - `F9` takes, editor opens after every take showing all takes.
- Mic status indicator in the prompt footer (idle / recording / transcribing).
- Large editable dialog for transcripts (Ctrl+Enter sends, Esc keeps).
- mlx-whisper GPU server (`servers/mlx_server.py`, ~2–3s per take).

## v0.1.0

- Toggle dictation: `f9` starts, `f9` stops; pauses never end the take.
- Local-only transcription via any OpenAI-compatible STT endpoint.
- Edit-before-send dialog prefilled with the transcript.
- Unit tests (VAD, WAV, options) + CI (test, typecheck, binary checksums).
