# Local speech-to-text

opencode-voice sends audio to an OpenAI-compatible
`/audio/transcriptions` endpoint. Default: `http://127.0.0.1:8080/v1`
(localhost — audio never leaves your machine).

## Install location (canonical)

Keep the server install in one place so the recovery skill can find it:

    ~/.local/share/opencode/voice-stt/
      mlx_server.py          # Apple Silicon GPU (preferred)
      mlx-env/               # its virtualenv
      mlx-server.log         # server log

(A legacy location, `~/.local/share/opencode/opencode-dictate/`, is also
checked by the skill if the canonical one is missing.)

## Quick health check

    curl -s -m 3 http://127.0.0.1:8080/health   # expect {"status": "ok"}

If it is down, restart it detached:

    cd ~/.local/share/opencode/voice-stt
    nohup ./mlx-env/bin/python3 mlx_server.py > mlx-server.log 2>&1 &

then re-run the health check every 5 s — the model loads in ~10–25 s on a
cold start. The `/voice-check` skill automates exactly this.

## mlx-whisper (recommended, Apple Silicon)

Dependency-free server using
[faster-whisper](https://github.com/SYSTRAN/faster-whisper)
(CTranslate2 port of OpenAI Whisper, 2–4× faster, CPU-friendly):

```sh
python3 -m venv stt-env
stt-env/bin/pip install faster-whisper
WHISPER_MODEL=small VOICE_STT_PORT=8080 stt-env/bin/python3 server.py
```

`server.py` sketch (stdlib only, plus `faster-whisper`): serve
`POST /v1/audio/transcriptions` with multipart `file` + `model` fields,
return `{"text": ...}`. `GET /health` must return `{"status": "ok"}`.

## Model choice (mac CPU, int8)

| Model | Size | Speed/take | Notes |
|---|---|---|---|
| `base` | ~150 MB | fastest | noticeably worse |
| `small` | ~500 MB | ~1–3 s | good default |
| `small.en` | ~500 MB | ~1–3 s | English-only, slightly better at English |
| `medium` | ~1.5 GB | ~5–10 s | big accuracy jump |
| `large-v3` | ~3 GB | very slow on CPU | best; needs GPU to be practical |

Switch with `WHISPER_MODEL=medium ...` and restart the server.
The plugin needs no changes — it just POSTs audio to the endpoint.

## Alternatives

Any OpenAI-compatible endpoint works: whisper.cpp server, LM Studio /
Ollama with STT support, or a cloud API (note: cloud uploads your voice).
Point the plugin at it via the `stt` option.
