"""Minimal HTTP front for AI4Bharat IndicF5.

IndicF5 ships inference code, not a server, so this implements the contract in
README.md and nothing more. Deliberately small: the interesting failure modes
here are operational (cold weights, a missing reference clip, OOM), not logical,
and a large server would hide them.

⚠️ No authentication. Bind to loopback and put a proxy in front — see README.
"""
import io
import os
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

import numpy as np
import soundfile as sf
from transformers import AutoModel

MODEL_ID = os.environ.get("INDICF5_MODEL", "ai4bharat/IndicF5")
VOICES_DIR = os.environ.get("INDICF5_VOICES", "/voices")
PORT = int(os.environ.get("PORT", "8080"))
API_KEY = os.environ.get("INDICF5_API_KEY", "")

_model = None
_lock = threading.Lock()          # one GPU, one generation at a time


def model():
    """Loaded once, lazily. The first request pays for the weights."""
    global _model
    with _lock:
        if _model is None:
            import torch
            dev = "cuda" if torch.cuda.is_available() else "cpu"
            _model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True).to(dev)
    return _model


def voices():
    """A voice is a .wav plus a .txt holding that clip's EXACT transcript."""
    if not os.path.isdir(VOICES_DIR):
        return {}
    out = {}
    for f in os.listdir(VOICES_DIR):
        if not f.endswith(".wav"):
            continue
        name = f[:-4]
        txt = os.path.join(VOICES_DIR, name + ".txt")
        if os.path.exists(txt):
            out[name] = (os.path.join(VOICES_DIR, f), txt)
    return out


def to_wav(audio, sample_rate):
    """float32/int16 array -> 16-bit mono WAV bytes."""
    a = np.asarray(audio)
    if a.dtype != np.int16:
        peak = float(np.max(np.abs(a))) or 1.0
        # Normalise rather than clip: IndicF5 returns floats that can exceed 1.0,
        # and clipping them is audible as crackle on exactly the loud syllables.
        a = (a / peak * 32767.0 * 0.98).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(a.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        if not API_KEY:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {API_KEY}"

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True, "voices": sorted(voices()), "warm": _model is not None})
        return self._json(404, {"error": "not_found"})

    def do_POST(self):
        if not self.path.startswith("/tts"):
            return self._json(404, {"error": "not_found"})
        if not self._authed():
            return self._json(401, {"error": "unauthorized"})

        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "invalid_json"})

        text = str(req.get("text") or "").strip()
        if not text:
            return self._json(400, {"error": "text_required"})

        name = str(req.get("voice") or "")
        available = voices()
        if name not in available:
            # Naming the available voices is safe here (this is a private box)
            # and turns the most common misconfiguration into a one-line fix.
            return self._json(400, {"error": "unknown_voice", "voice": name, "available": sorted(available)})

        ref_wav, ref_txt = available[name]
        with open(ref_txt, encoding="utf-8") as fh:
            ref_text = fh.read().strip()

        try:
            with _lock:
                audio = model()(text, ref_audio_path=ref_wav, ref_text=ref_text)
        except Exception as err:            # noqa: BLE001 — the caller needs the reason
            return self._json(500, {"error": "synthesis_failed", "detail": str(err)[:300]})

        sr = int(req.get("sample_rate") or sf.info(ref_wav).samplerate)
        body = to_wav(audio, sr)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Never log request bodies: they are things real people said on a call.
        print(f"{self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}")


if __name__ == "__main__":
    print(f"indicf5 serving on :{PORT} — voices: {sorted(voices()) or 'NONE (mount /voices)'}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
