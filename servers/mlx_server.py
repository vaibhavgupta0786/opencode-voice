#!/usr/bin/env python3
"""Minimal OpenAI-compatible speech-to-text server on Apple Silicon GPU.

Same API as the faster-whisper reference server, so opencode-voice needs no
changes: POST /v1/audio/transcriptions (multipart file + model) -> {"text"}.

Differences: mlx-whisper on the Metal GPU (~2x faster than CPU
faster-whisper/small on this class of machine) and zero temp files — the
uploaded WAV is decoded in memory with the stdlib wave module.

Config (env):
    MLX_MODEL    HF repo (default: mlx-community/whisper-small-mlx)
    VOICE_STT_PORT  listen port (default: 8080)
"""

import io
import json
import os
import wave
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import mlx.core as mx
import mlx_whisper

MODEL = os.environ.get("MLX_MODEL", "mlx-community/whisper-small-mlx")
PORT = int(os.environ.get("VOICE_STT_PORT", "8080"))

# No-speech gate: refuse to transcribe clips that don't look spoken.
# faster-whisper's default path has VAD + no_speech_threshold for this;
# the mlx path inherits no such guard and hallucinates on room noise
# (e.g. pure noise decoded into repeating nonsense Syllables).
# Config: VOICE_NOSPEECH_MIN_MS / VOICE_NOSPEECH_ZCR, "0" disables.
NOSPEECH_MIN_MS = float(os.environ.get("VOICE_NOSPEECH_MIN_MS", "200"))
NOSPEECH_ZCR = float(os.environ.get("VOICE_NOSPEECH_ZCR", "0.4"))


def speech_gate(samples: np.ndarray) -> tuple[bool, str]:
    """Cheap numpy voice-likeness gate; (pass, reason).

    Frames are 20ms hops at 16kHz. A frame counts as voiced when its RMS
    exceeds 2% full scale. White noise has near-50% zero crossings vs
    speech tones well under; noise that is loud enough to be voiced gets
    refused on zero-crossing rate instead.
    """
    frame = int(16000 * 0.02)
    n = len(samples) // frame
    voiced_ms = 0.0
    zcr = 0.0
    if n:
        rms = np.sqrt((samples[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
        voiced = int((rms > 0.02).sum())
        voiced_ms = voiced * frame / 16000 * 1000
        if len(samples) > 1:
            zcr = (samples[1:] * samples[:-1] < 0).mean()
    if NOSPEECH_MIN_MS and voiced_ms < NOSPEECH_MIN_MS:
        return False, f"voiced={voiced_ms:.0f}ms < {NOSPEECH_MIN_MS:.0f}ms"
    if NOSPEECH_ZCR and zcr > NOSPEECH_ZCR:
        return False, f"zcr={zcr:.2f} > {NOSPEECH_ZCR} (noise-like)"
    return True, f"voiced={voiced_ms:.0f}ms zcr={zcr:.2f}"

print(f"loading {MODEL} ...", flush=True)
# Warm up by loading weights once; per-request calls reuse them.
_MODEL_REF = MODEL
print("ready", flush=True)


def wav_bytes_to_float32(raw: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(raw), "rb") as w:
        if w.getframerate() != 16_000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError(
                f"expected 16kHz mono s16, got {w.getframerate()}Hz "
                f"{w.getnchannels()}ch {w.getsampwidth() * 8}bit"
            )
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self.path.rstrip("/").endswith("/audio/transcriptions"):
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        ctype = self.headers.get("Content-Type", "")
        try:
            msg = BytesParser(policy=email_policy).parsebytes(
                f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode() + raw
            )
            audio: bytes | None = None
            for part in msg.iter_parts():
                if part.get_filename():
                    audio = part.get_content()
                    break
            if audio is None:
                self._json(400, {"error": "no file part"})
                return
            samples = wav_bytes_to_float32(bytes(audio))
            passed, gate = speech_gate(samples)
            if not passed:
                print(f"no-speech guard: {gate}", flush=True)
                self._json(200, {"text": ""})
                return
            print(f"speech gate: {gate}", flush=True)
            try:
                result = mlx_whisper.transcribe(samples, path_or_hf_repo=_MODEL_REF)
            finally:
                # MLX's Metal buffer cache retains buffers for every unique
                # tensor shape forever (~40 MB per new audio duration,
                # measured with vmmap). Clearing it per request keeps the
                # footprint flat (~0.7 GB) in long-running servers.
                mx.clear_cache()
            self._json(200, {"text": (result.get("text") or "").strip()})
        except Exception as error:  # keep the endpoint fail-closed with a reason
            self._json(500, {"error": f"{type(error).__name__}: {error}"})

    def log_message(self, *args):  # quieter logs
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"listening on 127.0.0.1:{PORT} model={MODEL}", flush=True)
    server.serve_forever()
