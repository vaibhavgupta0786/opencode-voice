# Changelog

## v0.3.6

- Fix a v0.3.5 install hazard: `@opencode/plugin` is now capped at
  `>=2.0.12 <2.0.21`. SDK `2.0.21+` raises its OpenTUI peer floor beyond
  this plugin's pinned 0.5.12 runtime deps, so unconstrained resolution
  could fail fresh installs (ERESOLVE). OpenCode resolves the SDK at
  runtime, so hosts remain unaffected — 2.0.12 / 2.0.28 / 2.1.3 hosts all
  verified working.
- README: V2-only note and a **Compatibility** section — OpenCode
  `2.0.12`, `2.0.28`, and `2.1.3` verified against the published package
  with real standalone boots (plugin renders, zero plugin errors).
- Lockfile synced (was stale since 0.3.1); typecheck compiles against
  the lockfile's `@opencode/plugin` version.
- Raising the plugin's own `@opentui/*` pins to reach SDK `2.0.21+`
  (still `0.5.x`, + a full 0.6 migration) is deferred to a follow-up.

## v0.3.5

- STT server fix: the bundled mlx server now clears the MLX Metal buffer
  cache after every transcription request (`mx.clear_cache()` in a
  `finally`). The cache previously retained buffers for every unique
  audio-shape (~40 MB each), which ratcheted a 25-day-old server to
  7.7 GB of GPU memory; the footprint now stays flat at ~0.7 GB.

## v0.3.4

- Package metadata only (no code changes): added `keywords` so the plugin is
  discoverable in npm search, plus `homepage` / `bugs` links.

## v0.3.3

- Added the `repository` field so npm trusted publishing can attest provenance.

## v0.3.1

- `@jsxImportSource @opentui/solid` pragma and real runtime deps
  (`solid-js`, `@opentui/solid`, `@opentui/core`) so JSX transpiled from the
  npm cache resolves the Solid runtime instead of `react/jsx-runtime`.

## v0.3.0

- STT server health dot in the footer: `🟢🎤` / `🔴🎤` for local servers
  (30 s heartbeat + check on load + refresh on every take and after every
  STT failure, so a green dot can never outlive a failed take). Cloud STT
  endpoints show no dot — they expose no health route to check.
- `voice-check` recovery skill: `/voice-setup` (explicit one-time opt-in)
  installs it globally; `@voice-check` (or "voice is dead") has the agent
  verify and restart the local STT server. STT failure toasts point at it.
  The skill ships inside the package but is never installed silently.

## v0.2.0

- Mid-take session switch discards the take: the recorder is killed within 500 ms, transcription is skipped entirely (and any in-flight STT result is dropped), and a toast confirms. Only the in-flight take is discarded — no draft is touched. Previously the take kept recording into the old session and its editor opened over the new one.
- Drafts are **per session**: each chat keeps its own draft (text + take
  count); switching chats never mixes or loses them. (Previously the footer
  slot remounted on every chat switch and reset the single shared draft.)
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
