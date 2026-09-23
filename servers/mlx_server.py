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
import mlx_whisper

MODEL = os.environ.get("MLX_MODEL", "mlx-community/whisper-small-mlx")
PORT = int(os.environ.get("VOICE_STT_PORT", "8080"))

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
            result = mlx_whisper.transcribe(samples, path_or_hf_repo=_MODEL_REF)
            self._json(200, {"text": (result.get("text") or "").strip()})
        except Exception as error:  # keep the endpoint fail-closed with a reason
            self._json(500, {"error": f"{type(error).__name__}: {error}"})

    def log_message(self, *args):  # quieter logs
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"listening on 127.0.0.1:{PORT} model={MODEL}", flush=True)
    server.serve_forever()
