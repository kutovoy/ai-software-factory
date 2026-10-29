#!/usr/bin/env python3
"""
ytx - YouTube research bundle toolkit.

Subcommands:
  fetch  <url> --out DIR [--quality 1080] [--no-video]
  frames <dir> --at 9:11,10:30 [--range 9:00-12:30] [--every 2]
  scene  <dir> [--threshold 0.3] [--min-gap 1.0]
  bundle <url> --out DIR

Design notes live in README.md next to this file.
Dependency-light: stdlib + yt-dlp + ffmpeg/ffprobe. faster-whisper is only
needed when a video has no captions at all (installed into tools/yt/.venv
via uv on demand).
"""

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
VENV_DIR = TOOL_DIR / ".venv"
ASR_SCRIPT = TOOL_DIR / "_asr.py"
DEFAULT_ASR_MODEL = "small.en"

VIDEO_EXTS = (".mp4", ".mkv", ".webm", ".mov")

# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #


def run(cmd, check=True, capture=True):
    """Run a subprocess, return CompletedProcess. Raises with stderr tail."""
    proc = subprocess.run(
        [str(c) for c in cmd],
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True,
    )
    if check and proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-6:]
        raise RuntimeError(
            "command failed (%d): %s\n%s" % (proc.returncode, " ".join(map(str, cmd)), "\n".join(tail))
        )
    return proc


def tool_version(cmd):
    try:
        p = run([cmd, "--version"], check=False)
        out = (p.stdout or p.stderr or "").strip().splitlines()
        return out[0].strip() if out else "unknown"
    except Exception:
        return "missing"


def ffmpeg_version():
    try:
        p = run(["ffmpeg", "-version"], check=False)
        line = (p.stdout or "").strip().splitlines()[0]
        m = re.search(r"ffmpeg version (\S+)", line)
        return m.group(1) if m else line
    except Exception:
        return "missing"


def parse_time(value):
    """'9:11' -> 551.0, '1:02:03' -> 3723.0, '551.5' -> 551.5"""
    s = str(value).strip()
    if not s:
        raise ValueError("empty timestamp")
    if ":" in s:
        parts = [float(p) for p in s.split(":")]
        total = 0.0
        for p in parts:
            total = total * 60.0 + p
        return total
    return float(s)


def fmt_mmss(seconds):
    total = int(round(seconds))
    return "%02d:%02d" % (total // 60, total % 60)


def fmt_hms(seconds):
    total = int(round(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return "%d:%02d:%02d" % (h, m, s)


def stamp_for_filename(seconds):
    total = int(round(seconds))
    m, s = divmod(total, 60)
    if m >= 100:
        return "%03d%02d" % (m, s)
    return "%02d%02d" % (m, s)


def find_video(out_dir):
    for ext in VIDEO_EXTS:
        p = Path(out_dir) / ("video" + ext)
        if p.exists():
            return p
    # fall back to any video-ish file in the dir
    for p in sorted(Path(out_dir).glob("*")):
        if p.suffix.lower() in VIDEO_EXTS:
            return p
    return None


def load_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path, data):
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# probing / downloading
# --------------------------------------------------------------------------- #


def probe(url):
    """yt-dlp -J -> full info dict. This is the single source of truth for
    title/channel/duration and for which caption tracks exist."""
    p = run(["yt-dlp", "-J", "--no-playlist", "--no-warnings", url])
    return json.loads(p.stdout)


def probe_video_file(path):
    """ffprobe the downloaded file: what we actually got, not what YouTube listed."""
    try:
        p = run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-show_entries", "format=duration", "-of", "json", str(path),
        ])
        data = json.loads(p.stdout or "{}")
        st = (data.get("streams") or [{}])[0]
        fr = st.get("r_frame_rate") or "0/1"
        num, den = fr.split("/")
        fps = round(float(num) / float(den), 3) if float(den) else None
        return {
            "width": st.get("width"),
            "height": st.get("height"),
            "fps": fps,
            "duration_s": round(float((data.get("format") or {}).get("duration") or 0), 2),
        }
    except Exception:
        return {}


def meta_summary(info, url):
    vid = info.get("id") or ""
    w = info.get("width") or 0
    h = info.get("height") or 0
    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    return {
        "source_url": url,
        "video_id": vid,
        "title": info.get("title") or "",
        "channel": info.get("channel") or info.get("uploader") or "",
        "uploader": info.get("uploader") or "",
        "duration_s": float(info.get("duration") or 0),
        "duration_hms": fmt_hms(float(info.get("duration") or 0)),
        "resolution": ("%dx%d" % (w, h)) if (w and h) else "",
        "fps": info.get("fps") or None,
        "upload_date": info.get("upload_date") or "",
        "webpage_url": info.get("webpage_url") or url,
        "has_manual_subs": bool(subs),
        "manual_sub_langs": sorted(subs.keys()),
        "has_auto_subs": bool(autos),
        "auto_sub_langs": sorted(autos.keys())[:12],
    }


def download_video(url, out_dir, quality, force=False):
    existing = find_video(out_dir)
    if existing and not force:
        log("[fetch] video already present: %s (skipping)" % existing.name)
        return existing, False
    fmt = "bv*[height<=%d]+ba/b[height<=%d]/b" % (quality, quality)
    cmd = [
        "yt-dlp",
        "-f", fmt,
        "--merge-output-format", "mp4",
        "--no-playlist",
        "--no-progress",
        "--write-info-json",
        "-o", str(Path(out_dir) / "video.%(ext)s"),
        url,
    ]
    log("[fetch] downloading: %s" % fmt)
    run(cmd)
    vid = find_video(out_dir)
    if vid is None:
        raise RuntimeError("yt-dlp finished but no video file was produced")
    return vid, True


SUB_LANGS = "en.*,en,en-US,en-GB"


def download_subtitles(url, out_dir, force=False):
    """Download manual and auto caption tracks into separate folders so we can
    tell them apart (yt-dlp issue #57: both land under the same filename)."""
    subs_root = Path(out_dir) / "captions"
    subs_root.mkdir(parents=True, exist_ok=True)
    found = {"manual": [], "auto": []}

    for kind, flag in (("manual", "--write-subs"), ("auto", "--write-auto-subs")):
        tmp = subs_root / kind
        tmp.mkdir(parents=True, exist_ok=True)
        if any(tmp.iterdir()) and not force:
            log("[fetch] %s captions already present (skipping)" % kind)
        else:
            for f in tmp.iterdir():
                f.unlink()
            cmd = [
                "yt-dlp",
                "--skip-download",
                flag,
                "--sub-langs", SUB_LANGS,
                "--sub-format", "json3/vtt/best",
                "--no-playlist",
                "--no-progress",
                "-o", str(tmp / "%(ext)s"),
                url,
            ]
            p = run(cmd, check=False)
            if p.returncode != 0:
                log("[fetch] %s caption fetch returned %d (ignored)" % (kind, p.returncode))
        found[kind] = sorted(
            [f for f in tmp.iterdir() if f.suffix.lower() in (".json3", ".vtt", ".srt")]
        )
        log("[fetch] %s caption files: %d" % (kind, len(found[kind])))

    # If json3/vtt yielded nothing, retry once with the srt conversion path.
    if not found["manual"] and not found["auto"]:
        tmp = subs_root / "converted"
        tmp.mkdir(parents=True, exist_ok=True)
        if not any(tmp.iterdir()) or force:
            cmd = [
                "yt-dlp", "--skip-download",
                "--write-subs", "--write-auto-subs",
                "--sub-langs", SUB_LANGS,
                "--sub-format", "vtt/best",
                "--convert-subs", "srt",
                "--no-playlist", "--no-progress",
                "-o", str(tmp / "%(ext)s"),
                url,
            ]
            run(cmd, check=False)
        conv = sorted(tmp.glob("*.srt"))
        if conv:
            log("[fetch] srt-conversion fallback produced %d file(s)" % len(conv))
            found["auto"] = conv

    return found


# --------------------------------------------------------------------------- #
# caption parsing + normalization
# --------------------------------------------------------------------------- #

TS = r"(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})"
CUE_RE = re.compile(r"^\s*" + TS + r"\s*-->\s*" + TS)
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def _ts_to_s(value):
    value = value.replace(",", ".")
    parts = [float(p) for p in value.split(":")]
    total = 0.0
    for p in parts:
        total = total * 60.0 + p
    return total


def parse_vtt_srt(text):
    cues = []
    cur = None
    for line in text.splitlines():
        m = CUE_RE.match(line)
        if m:
            if cur and cur[2]:
                cues.append(cur)
            cur = [_ts_to_s(m.group(1)), _ts_to_s(m.group(2)), ""]
            continue
        if cur is None:
            continue
        if not line.strip():
            if cur[2]:
                cues.append(cur)
                cur = None
            continue
        if line.strip().isdigit() and not cur[2]:
            continue
        cur[2] = (cur[2] + " " + line.strip()).strip()
    if cur and cur[2]:
        cues.append(cur)
    return [(a, b, TAG_RE.sub("", t)) for a, b, t in cues]


def parse_json3(text):
    data = json.loads(text)
    cues = []
    for ev in data.get("events") or []:
        segs = ev.get("segs") or []
        if not segs:
            continue
        txt = "".join(s.get("utf8", "") for s in segs)
        txt = TAG_RE.sub("", txt).replace("\n", " ").strip()
        if not txt:
            continue
        start = float(ev.get("tStartMs", 0)) / 1000.0
        dur = float(ev.get("dDurationMs", 0)) / 1000.0
        cues.append((start, start + (dur if dur > 0 else 2.0), txt))
    return cues


def read_caption_file(path):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    suffix = Path(path).suffix.lower()
    if suffix == ".json3":
        return parse_json3(text)
    return parse_vtt_srt(text)


def clean_cues(cues):
    """YouTube auto captions are 'rolling': cue N repeats cue N-1's text and
    appends the new line. Strip the repeated prefix so we keep only new words.
    Also drop zero-length and pure-music cues."""
    out = []
    last = ""
    for start, end, text in cues:
        text = WS_RE.sub(" ", text).strip()
        if not text:
            continue
        if text == last:
            continue
        if last and text.startswith(last):
            text = text[len(last):].strip()
            if not text:
                last = text
                continue
        elif last and len(text) > 3 and text in last:
            continue
        last = text
        if re.fullmatch(r"[\[\(]?(music|applause|laughter|silence)[\]\)]?", text, re.I):
            continue
        out.append([start, end if end > start else start + 1.0, text])
    return out


def merge_cues(cues, max_gap=1.2, max_chars=170):
    merged = []
    for start, end, text in cues:
        if merged:
            ps, pe, pt = merged[-1]
            if start - pe <= max_gap and len(pt) + len(text) + 1 <= max_chars:
                merged[-1] = [ps, max(pe, end), (pt + " " + text).strip()]
                continue
        merged.append([start, end, text])
    # final tidy: collapse double spaces, drop trailing commas artifacts
    return [[round(s, 3), round(e, 3), WS_RE.sub(" ", t)] for s, e, t in merged]


def write_transcript(out_dir, segments, meta, source, lang="", caption_source="none"):
    out_dir = Path(out_dir)
    payload = {
        "source": source,
        "video_id": meta.get("video_id", ""),
        "title": meta.get("title", ""),
        "language": lang or "en",
        "caption_source": caption_source,
        "generated_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "segments": [{"start": s, "end": e, "text": t} for s, e, t in segments],
    }
    write_json(out_dir / "transcript.json", payload)

    # paragraph-grouped markdown
    lines = []
    lines.append("# %s" % (meta.get("title") or "Transcript"))
    lines.append("")
    if meta.get("channel"):
        lines.append("- Channel: %s" % meta["channel"])
    if meta.get("duration_hms"):
        lines.append("- Duration: %s" % meta["duration_hms"])
    lines.append("- Source: %s" % source)
    lines.append("- Caption source: %s" % caption_source)
    lines.append("")

    para = []
    para_chars = 0
    prev_end = None
    for s, e, t in segments:
        if prev_end is not None and (s - prev_end > 2.5 or para_chars > 700):
            if para:
                lines.extend(para)
                lines.append("")
            para, para_chars = [], 0
        para.append("[%s] %s" % (fmt_mmss(s), t))
        para_chars += len(t)
        prev_end = e
    if para:
        lines.extend(para)
    (out_dir / "transcript.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    plain = "\n".join(t for _, _, t in segments) + "\n"
    (out_dir / "transcript.txt").write_text(plain, encoding="utf-8")
    return payload


# --------------------------------------------------------------------------- #
# ASR fallback (faster-whisper in a local uv venv)
# --------------------------------------------------------------------------- #


def ensure_venv():
    py = VENV_DIR / "bin" / "python"
    if py.exists():
        return py
    log("[asr] creating venv at %s" % VENV_DIR)
    run(["uv", "venv", "--python", "3.11", str(VENV_DIR)])
    log("[asr] installing faster-whisper (first run only, ~1 min)")
    run(["uv", "pip", "install", "--python", str(py), "faster-whisper"])
    return py


def transcribe(url, out_dir, meta, model_name):
    tmp = Path(out_dir) / "captions" / "audio"
    tmp.mkdir(parents=True, exist_ok=True)
    audio_src = None
    for f in tmp.iterdir():
        if f.suffix.lower() in (".m4a", ".webm", ".opus", ".mp3", ".wav"):
            audio_src = f
            break
    if audio_src is None:
        log("[asr] downloading audio only")
        run([
            "yt-dlp", "-f", "ba/b", "--no-playlist", "--no-progress",
            "-o", str(tmp / "audio.%(ext)s"), url,
        ])
        for f in tmp.iterdir():
            if f.suffix.lower() in (".m4a", ".webm", ".opus", ".mp3", ".wav"):
                audio_src = f
                break
    if audio_src is None:
        raise RuntimeError("could not download audio for transcription")

    wav = tmp / "audio16k.wav"
    if not wav.exists():
        run([
            "ffmpeg", "-y", "-v", "error", "-i", str(audio_src),
            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav),
        ])

    py = ensure_venv()
    asr_json = tmp / "asr.json"
    log("[asr] transcribing with faster-whisper model=%s (CPU, first run downloads weights)" % model_name)
    run([py, ASR_SCRIPT, str(wav), str(asr_json), model_name])
    data = load_json(asr_json) or {}
    segs = data.get("segments") or []
    if not segs:
        raise RuntimeError("faster-whisper returned no segments")
    cues = [[float(s["start"]), float(s["end"]), s["text"]] for s in segs]
    return clean_cues(cues), "whisper:%s" % model_name, data.get("language", "en")


# --------------------------------------------------------------------------- #
# frames
# --------------------------------------------------------------------------- #

INDEX_NAME = "index.json"


def load_frame_index(frames_dir):
    data = load_json(Path(frames_dir) / INDEX_NAME, default=None)
    if isinstance(data, dict) and isinstance(data.get("frames"), list):
        return data["frames"]
    return []


def save_frame_index(frames_dir, entries):
    write_json(Path(frames_dir) / INDEX_NAME, {"frames": entries})


def add_frame(frames_dir, src_png, t, kind, entries):
    """Move a freshly written PNG into frames/frame_MMSS.png.

    Two dedupe rules: identical bytes, and same whole-second timestamp (the
    fps-filter range pass and the exact -ss pass can land one frame apart)."""
    frames_dir = Path(frames_dir)
    digest = md5_of(src_png)
    for e in entries:
        if e.get("md5") == digest or abs(e.get("timestamp", -99) - float(t)) < 0.6:
            src_png.unlink(missing_ok=True)
            return None
    base = "frame_%s" % stamp_for_filename(t)
    name = base + ".png"
    n = 2
    while (frames_dir / name).exists():
        existing_digest = md5_of(frames_dir / name)
        if existing_digest == digest:
            src_png.unlink(missing_ok=True)
            return None
        name = "%s_%d.png" % (base, n)
        n += 1
    dest = frames_dir / name
    shutil.move(str(src_png), str(dest))
    entry = {
        "file": name,
        "timestamp": round(float(t), 3),
        "mmss": fmt_mmss(t),
        "kind": kind,
        "md5": digest,
    }
    entries.append(entry)
    entries.sort(key=lambda e: (e["timestamp"], e["kind"], e["file"]))
    return entry


def nearest_transcript(segments, t, before=2.5, after=6.0, limit=2):
    if not segments:
        return ""
    picked = [s for s in segments if s["end"] >= t - before and s["start"] <= t + after]
    if not picked:
        best = min(segments, key=lambda s: abs((s["start"] + s["end"]) / 2.0 - t))
        picked = [best]
    picked = picked[:limit]
    return " / ".join("[%s] %s" % (fmt_mmss(s["start"]), s["text"]) for s in picked)


def render_frame_index(frames_dir, entries, segments, title=""):
    frames_dir = Path(frames_dir)
    lines = ["# Frame index%s" % ((" - " + title) if title else ""), ""]
    lines.append("| # | Frame | Timestamp | Kind | Nearest transcript |")
    lines.append("|---|-------|-----------|------|--------------------|")
    for i, e in enumerate(entries, 1):
        ctx = nearest_transcript(segments, e["timestamp"]).replace("|", "\\|")
        lines.append(
            "| %d | [%s](%s) | %s | %s | %s |"
            % (i, e["file"], e["file"], e["mmss"], e["kind"], ctx)
        )
    lines.append("")
    (frames_dir / "index.md").write_text("\n".join(lines), encoding="utf-8")


def extract_single(video, t, dest):
    run([
        "ffmpeg", "-y", "-v", "error",
        "-ss", "%.3f" % t, "-i", str(video),
        "-frames:v", "1", "-pix_fmt", "rgb24", str(dest),
    ])


def extract_range(video, start, end, every, workdir):
    """One ffmpeg pass with the fps filter; frame k lands at start + k*every."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    for f in workdir.glob("r_*.png"):
        f.unlink()
    run([
        "ffmpeg", "-y", "-v", "error",
        "-ss", "%.3f" % start, "-t", "%.3f" % max(0.1, end - start),
        "-i", str(video),
        "-vf", "fps=1/%s" % every,
        "-start_number", "0",
        "-pix_fmt", "rgb24",
        str(workdir / "r_%05d.png"),
    ])
    produced = sorted(workdir.glob("r_*.png"))
    return [(start + i * float(every), p) for i, p in enumerate(produced)]


def cmd_frames(args):
    out_dir = Path(args.dir).expanduser().resolve()
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    video = find_video(out_dir)
    if video is None:
        raise SystemExit("no video file in %s - run `fetch` first" % out_dir)

    segments = (load_json(out_dir / "transcript.json", default={}) or {}).get("segments", [])
    entries = load_frame_index(frames_dir)
    added = {"at": [], "range": []}

    work = frames_dir / "_tmp"
    work.mkdir(exist_ok=True)

    if args.at:
        for tok in args.at.split(","):
            tok = tok.strip()
            if not tok:
                continue
            t = parse_time(tok)
            tmp = work / ("at_%.3f.png" % t)
            extract_single(video, t, tmp)
            e = add_frame(frames_dir, tmp, t, "at", entries)
            if e:
                added["at"].append(e["file"])
                log("[frames] + %s @ %s" % (e["file"], e["mmss"]))
            else:
                log("[frames] = duplicate frame @ %s (skipped)" % fmt_mmss(t))

    if args.range:
        m = re.match(r"^\s*([0-9:.]+)\s*-\s*([0-9:.]+)\s*$", args.range)
        if not m:
            raise SystemExit("--range must look like 9:00-12:30")
        start, end = parse_time(m.group(1)), parse_time(m.group(2))
        every = float(args.every or 2)
        if end <= start:
            raise SystemExit("--range end must be after start")
        log("[frames] range %s-%s every %ss" % (fmt_mmss(start), fmt_mmss(end), every))
        for t, png in extract_range(video, start, end, every, work):
            e = add_frame(frames_dir, png, t, "range", entries)
            if e:
                added["range"].append(e["file"])
                log("[frames] + %s @ %s" % (e["file"], e["mmss"]))

    for f in work.glob("*.png"):
        f.unlink()
    shutil.rmtree(work, ignore_errors=True)

    save_frame_index(frames_dir, entries)
    meta = load_json(out_dir / "meta.json", default={}) or {}
    render_frame_index(frames_dir, entries, segments, meta.get("title", ""))
    update_manifest(out_dir, frame_count=len(entries))

    summary = {
        "command": "frames",
        "dir": str(out_dir),
        "frames_dir": str(frames_dir),
        "added_at": added["at"],
        "added_range_count": len(added["range"]),
        "total_frames": len(entries),
        "index": str(frames_dir / "index.md"),
    }
    print(json.dumps(summary, indent=2))
    return summary


# --------------------------------------------------------------------------- #
# scene detection
# --------------------------------------------------------------------------- #

SCENE_LOG_RE = re.compile(r"pts_time:([0-9.]+)")


def cmd_scene(args):
    out_dir = Path(args.dir).expanduser().resolve()
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    video = find_video(out_dir)
    if video is None:
        raise SystemExit("no video file in %s - run `fetch` first" % out_dir)

    threshold = float(args.threshold)
    work = frames_dir / "_scene_tmp"
    work.mkdir(exist_ok=True)
    for f in work.glob("*.png"):
        f.unlink()
    logfile = frames_dir / "_scene.log"

    vf = "select='gt(scene,%.4f)',metadata=mode=print:file=%s" % (threshold, logfile)
    log("[scene] detecting cuts (threshold=%s) - this decodes the whole video" % threshold)
    run([
        "ffmpeg", "-y", "-v", "error", "-i", str(video),
        "-vf", vf, "-fps_mode", "vfr",
        "-pix_fmt", "rgb24",
        str(work / "s_%05d.png"),
    ])

    times = []
    if logfile.exists():
        for line in logfile.read_text(encoding="utf-8", errors="replace").splitlines():
            m = SCENE_LOG_RE.search(line)
            if m:
                times.append(float(m.group(1)))

    produced = sorted(work.glob("s_*.png"))
    entries = load_frame_index(frames_dir)
    added = []
    min_gap = float(args.min_gap or 0.0)
    last_kept = None
    for idx, png in enumerate(produced):
        t = times[idx] if idx < len(times) else idx * 1.0
        if last_kept is not None and (t - last_kept) < min_gap:
            png.unlink(missing_ok=True)
            continue
        e = add_frame(frames_dir, png, t, "scene", entries)
        if e:
            added.append(e["file"])
            last_kept = t
            log("[scene] + %s @ %s" % (e["file"], e["mmss"]))

    for f in work.glob("*.png"):
        f.unlink()
    shutil.rmtree(work, ignore_errors=True)
    logfile.unlink(missing_ok=True)

    save_frame_index(frames_dir, entries)
    meta = load_json(out_dir / "meta.json", default={}) or {}
    segments = (load_json(out_dir / "transcript.json", default={}) or {}).get("segments", [])
    render_frame_index(frames_dir, entries, segments, meta.get("title", ""))
    update_manifest(out_dir, frame_count=len(entries), scene_threshold=threshold)

    summary = {
        "command": "scene",
        "dir": str(out_dir),
        "threshold": threshold,
        "detected": len(produced),
        "added": len(added),
        "total_frames": len(entries),
        "index": str(frames_dir / "index.md"),
    }
    print(json.dumps(summary, indent=2))
    return summary


# --------------------------------------------------------------------------- #
# manifest
# --------------------------------------------------------------------------- #


def update_manifest(out_dir, **kwargs):
    out_dir = Path(out_dir)
    path = out_dir / "manifest.json"
    man = load_json(path, default={}) or {}
    man.update(kwargs)
    man.pop("frames_total", None)  # legacy key from earlier versions
    man["updated_at"] = _dt.datetime.now().isoformat(timespec="seconds")
    if "tool_versions" not in man:
        man["tool_versions"] = {}
    man["tool_versions"].update({
        "yt-dlp": tool_version("yt-dlp"),
        "ffmpeg": ffmpeg_version(),
        "python": sys.version.split()[0],
    })
    write_json(path, man)
    return man


# --------------------------------------------------------------------------- #
# fetch / bundle
# --------------------------------------------------------------------------- #


def cmd_fetch(args):
    url = args.url
    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    info = probe(url)
    meta = meta_summary(info, url)
    write_json(out_dir / "meta.json", meta)
    log("[fetch] %s | %s | %s" % (meta["title"], meta["channel"], meta["duration_hms"]))

    video = None
    if not args.no_video:
        video, downloaded = download_video(url, out_dir, args.quality, force=args.force)
    else:
        log("[fetch] --no-video: skipping video download")

    subs = download_subtitles(url, out_dir, force=args.force)

    segments, caption_source, lang = [], "none", "en"
    manual = [f for f in subs["manual"] if f.exists()]
    auto = [f for f in subs["auto"] if f.exists()]
    chosen = None
    if manual:
        chosen, caption_source = manual[0], "manual"
    elif auto:
        chosen, caption_source = auto[0], "auto"
    if chosen is not None:
        cues = clean_cues(read_caption_file(chosen))
        segments = merge_cues(cues)
        log("[fetch] parsed %d segments from %s (%s)" % (len(segments), chosen.name, caption_source))

    if not segments:
        log("[fetch] no usable captions -> falling back to local ASR")
        segments, caption_source, lang = transcribe(url, out_dir, meta, args.asr_model)

    payload = write_transcript(out_dir, segments, meta, url, lang=lang, caption_source=caption_source)
    write_json(out_dir / "transcript.json", payload)

    frames_dir = out_dir / "frames"
    frames_dir.mkdir(exist_ok=True)
    entries = load_frame_index(frames_dir)
    render_frame_index(frames_dir, entries, payload["segments"], meta.get("title", ""))

    man = update_manifest(
        out_dir,
        source_url=url,
        video_id=meta["video_id"],
        title=meta["title"],
        channel=meta["channel"],
        duration_s=meta["duration_s"],
        duration_hms=meta["duration_hms"],
        resolution=meta["resolution"],
        fps=meta["fps"],
        caption_source=caption_source,
        caption_lang=lang,
        transcript_segments=len(segments),
        video_file=str(video) if video else None,
        video_file_probe=probe_video_file(video) if video else None,
        video_bytes=(video.stat().st_size if video else None),
        frame_count=len(entries),
        asr_model=(args.asr_model if caption_source.startswith("whisper") else None),
    )

    summary = {
        "command": "fetch",
        "dir": str(out_dir),
        "video": str(video) if video else None,
        "title": meta["title"],
        "channel": meta["channel"],
        "duration": meta["duration_hms"],
        "resolution": meta["resolution"],
        "caption_source": caption_source,
        "segments": len(segments),
        "transcript_json": str(out_dir / "transcript.json"),
        "transcript_md": str(out_dir / "transcript.md"),
        "manifest": str(out_dir / "manifest.json"),
        "tool_versions": man["tool_versions"],
    }
    print(json.dumps(summary, indent=2))
    return summary


def cmd_bundle(args):
    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    fetch_ns = argparse.Namespace(
        url=args.url, out=str(out_dir), quality=args.quality,
        no_video=args.no_video, force=args.force, asr_model=args.asr_model,
    )
    # fetch prints its own summary; suppress by capturing stdout
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fetch_summary = cmd_fetch(fetch_ns)

    scene_summary = None
    if not args.no_video:
        scene_ns = argparse.Namespace(
            dir=str(out_dir), threshold=args.scene_threshold, min_gap=args.min_gap,
        )
        buf2 = io.StringIO()
        with contextlib.redirect_stdout(buf2):
            scene_summary = cmd_scene(scene_ns)

    frames_summary = None
    if args.at or args.range:
        frames_ns = argparse.Namespace(
            dir=str(out_dir), at=args.at, range=args.range, every=args.every,
        )
        buf3 = io.StringIO()
        with contextlib.redirect_stdout(buf3):
            frames_summary = cmd_frames(frames_ns)

    man = update_manifest(out_dir)
    summary = {
        "command": "bundle",
        "dir": str(out_dir),
        "title": fetch_summary["title"],
        "channel": fetch_summary["channel"],
        "duration": fetch_summary["duration"],
        "resolution": fetch_summary["resolution"],
        "caption_source": fetch_summary["caption_source"],
        "transcript_segments": fetch_summary["segments"],
        "scene_frames_added": (scene_summary or {}).get("added", 0),
        "extra_frames_added": (frames_summary or {}).get("added_range_count", 0)
        + len((frames_summary or {}).get("added_at", [])),
        "total_frames": man.get("frame_count", 0),
        "manifest": str(out_dir / "manifest.json"),
    }
    print(json.dumps(summary, indent=2))
    return summary


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser():
    p = argparse.ArgumentParser(prog="ytx", description="YouTube research bundle toolkit")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="download video + captions, normalize transcript")
    f.add_argument("url")
    f.add_argument("--out", required=True)
    f.add_argument("--quality", type=int, default=1080)
    f.add_argument("--no-video", action="store_true")
    f.add_argument("--force", action="store_true", help="re-download even if present")
    f.add_argument("--asr-model", default=DEFAULT_ASR_MODEL)
    f.set_defaults(func=cmd_fetch)

    fr = sub.add_parser("frames", help="extract PNG frames at timestamps / ranges")
    fr.add_argument("dir")
    fr.add_argument("--at", default="", help="comma list, e.g. 9:11,10:30")
    fr.add_argument("--range", default="", help="e.g. 9:00-12:30")
    fr.add_argument("--every", type=float, default=2.0)
    fr.set_defaults(func=cmd_frames)

    sc = sub.add_parser("scene", help="scene-change detection frames")
    sc.add_argument("dir")
    sc.add_argument("--threshold", type=float, default=0.3)
    sc.add_argument("--min-gap", type=float, default=1.0)
    sc.set_defaults(func=cmd_scene)

    b = sub.add_parser("bundle", help="fetch + scene + optional frames + manifest")
    b.add_argument("url")
    b.add_argument("--out", required=True)
    b.add_argument("--quality", type=int, default=1080)
    b.add_argument("--no-video", action="store_true")
    b.add_argument("--force", action="store_true")
    b.add_argument("--asr-model", default=DEFAULT_ASR_MODEL)
    b.add_argument("--scene-threshold", type=float, default=0.3)
    b.add_argument("--min-gap", type=float, default=1.0)
    b.add_argument("--at", default="")
    b.add_argument("--range", default="")
    b.add_argument("--every", type=float, default=2.0)
    b.set_defaults(func=cmd_bundle)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except RuntimeError as exc:
        log("ERROR: %s" % exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
