#!/usr/bin/env python3
"""Local ASR helper, run by ytx.py inside tools/yt/.venv.

usage: _asr.py <audio.wav> <out.json> <model>
"""
import json
import sys

from faster_whisper import WhisperModel

audio, out_path, model_name = sys.argv[1], sys.argv[2], sys.argv[3]

model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, info = model.transcribe(
    audio,
    language="en",
    beam_size=5,
    vad_filter=True,
    vad_parameters={"min_silence_duration_ms": 500},
)

rows = []
for seg in segments:
    text = (seg.text or "").strip()
    if not text:
        continue
    rows.append({"start": round(float(seg.start), 3), "end": round(float(seg.end), 3), "text": text})

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump({"language": info.language, "segments": rows}, fh, indent=2, ensure_ascii=False)

print("wrote %d segments" % len(rows), file=sys.stderr)
