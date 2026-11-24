"""Private stdin/stdout worker. Audio is decoded in memory and never saved."""
import base64
import io
import json
import os
import sys

from faster_whisper import WhisperModel

model = WhisperModel(
    "small", device="cpu", compute_type="int8", cpu_threads=min(4, os.cpu_count() or 1),
    download_root=sys.argv[1],
)
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        audio = base64.b64decode(request["audio"], validate=True)
        segments, info = model.transcribe(
            io.BytesIO(audio), language=None, task="transcribe", beam_size=3,
            vad_filter=True, condition_on_previous_text=False,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        print(json.dumps({"id": request["id"], "text": text, "language": info.language}, ensure_ascii=False), flush=True)
    except Exception:
        print(json.dumps({"id": request.get("id"), "error": "Transcription failed"}), flush=True)
