---
name: Voice Check
description: Check and restart the local whisper STT server that the opencode-voice dictation plugin uses on port 8080. Use when voice dictation fails, an "STT failed" error appears, or the user asks to fix, prepare, check, or bring back voice input.
---

# Voice STT server check

The opencode-voice plugin transcribes dictation through a local whisper
server at http://127.0.0.1:8080. When that server is down, every take
fails with "STT failed". Work these steps in order; stop at the first one
that resolves the situation.

## 1. Health check

    curl -s -m 3 http://127.0.0.1:8080/health

If it prints `{"status": "ok"}`, the server is up — report that dictation
should work (press Fn+F9) and stop. Nothing is broken.

## 2. Locate the server install

Check these directories in order; the server dir is the first that
contains a server file and a Python virtualenv:

1. `~/.local/share/opencode/voice-stt` — canonical location (see the
   opencode-voice repo's `docs/STT.md`)
2. `~/.local/share/opencode/opencode-dictate` — legacy location

Inside the server dir, expect one of:

- `mlx_server.py` + `mlx-env/` — mlx-whisper on the Apple Silicon GPU
  (preferred), or
- `server.py` + `stt-env/` — faster-whisper on CPU

If neither directory exists, the STT server was never installed. Point the
user to the opencode-voice repo's `docs/STT.md` and stop.

## 3. Restart the server

Clear anything still holding the port (ignore errors):

    lsof -ti:8080 | xargs kill -9

Start detached. If `mlx_server.py` exists:

    cd <server-dir> && nohup ./mlx-env/bin/python3 mlx_server.py > mlx-server.log 2>&1 &

otherwise:

    cd <server-dir> && WHISPER_MODEL=small nohup ./stt-env/bin/python3 server.py > stt-server.log 2>&1 &

## 4. Wait for boot, then re-verify

Poll the health endpoint every 5 seconds, up to 30 seconds total — the
model loads from cache in roughly 10-25 s on a cold start:

    curl -s -m 3 http://127.0.0.1:8080/health

## 5. If it still will not start

Show the last 10-20 lines of the server log (`mlx-server.log` or
`stt-server.log`) and report the error you see. Do not guess further.

## 6. Report

One line: server was up / has been restarted / failed (with the error).
Remind the user to press Fn+F9 to dictate.
