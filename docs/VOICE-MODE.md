# Voice mode (PARKED — future separate project)

Goal: full ChatGPT-style voice mode for OpenCode — always-on mic plus
spoken answers. Parked until voice input (this repo) is solid.

## Background (from OpenAI's realtime/TTS/VAD docs)

Three architectures exist: Realtime API (one audio→audio model), chained
pipeline (STT → text agent → TTS), GPT-Live (voice frontend + text backend).
Locally only the **chained pipeline** is viable — and it's the right one:
we want to see and control the text between stages.

The five moving parts: VAD/turn-taking, STT (✅ done here, mlx GPU),
brain, streaming TTS, barge-in + audio plumbing.

References: `server_vad` vs `semantic_vad` (OpenAI judges "are they done?"
from words, not just silence); TTS streams PCM before generation finishes;
first-audio latency is the metric; `gpt-4o-mini-tts` with 11+ voices.

## Why coding voice mode ≠ ChatGPT voice

1. **Outputs are 1000-word audits, not sentences.** A digest layer
   (verdict first, 2 things that matter, then ask) is core, not a feature.
2. **Work takes minutes.** Need status whispers while tools run, and
   interruption mid-tool-run (`session.interrupt` — verify TUI access).
3. **Permissions by voice are dangerous.** Never auto-answer; read aloud,
   require explicit confirm (possibly typed, not spoken).

## Proposed shape

Separate project with three independently toggleable modes: push-to-talk
(this repo), conversation (open mic, auto-send), voice-out (spoken
digests). Reuse recorder + mlx STT + session APIs. New: Silero VAD,
digest LLM prompt, TTS engine + player, barge-in wiring.

## Suggested order

1. TTS bake-off on Apple Silicon (Piper vs Kokoro vs mlx-audio vs `say`):
   naturalness vs latency, same paragraph.
2. Digest prompt design (the real product work).
3. Always-on loop with barge-in.
4. Permission-safety rules.
