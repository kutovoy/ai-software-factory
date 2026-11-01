# `ytx` — YouTube research bundles (video + transcript + frames)

One CLI that turns a YouTube URL into a self-contained research folder: the video,
a normalized transcript (JSON + readable Markdown), timestamped PNG frames, scene-change
frames, and a `manifest.json` that records provenance and tool versions.

Built for the "software factory" research work in this repo: we need to *watch* talks
(frame-by-frame) and *quote* them precisely, not just skim a summary.

```
research/videos/<video_id>/
  video.mp4                 # merged mp4, <= requested height
  meta.json                 # trimmed yt-dlp metadata (title/channel/duration/resolution)
  video.info.json           # raw yt-dlp info (full format list)
  captions/
    manual/ auto/ converted/  # raw caption files (json3 / vtt / srt)
  transcript.json           # [{start, end, text}] + caption_source + language
  transcript.md             # [MM:SS] lines, paragraph-grouped
  transcript.txt            # plain text
  frames/
    frame_MMSS.png          # exact-timestamp / range / scene frames
    index.json              # machine-readable frame registry (md5, ts, kind)
    index.md                # table: frame -> timestamp -> nearest transcript lines
  manifest.json             # url, title, channel, duration, caption source, counts, versions
```

## Install

Nothing to install beyond what is already on the machine: `yt-dlp`, `ffmpeg`,
`ffprobe`, Python 3.9+. `faster-whisper` is only needed when a video has **no**
captions at all; `ytx` creates `tools/yt/.venv` with `uv` and installs it on demand
(~1 min, first run only).

```bash
python3 tools/yt/ytx.py --help
```

## Commands

```bash
# 1. video + captions + normalized transcript
python3 tools/yt/ytx.py fetch <url> --out DIR [--quality 1080] [--no-video]

# 2. frames at exact timestamps and/or a range
python3 tools/yt/ytx.py frames DIR --at 9:11,10:30
python3 tools/yt/ytx.py frames DIR --range 9:00-12:30 --every 2

# 3. scene-change frames (slide / UI transitions)
python3 tools/yt/ytx.py scene DIR --threshold 0.3 --min-gap 1.0

# 4. everything in one shot
python3 tools/yt/ytx.py bundle <url> --out DIR \
    [--at 9:11] [--range 9:00-12:30] [--every 2] [--scene-threshold 0.3]
```

Every command prints a JSON summary on stdout; progress goes to stderr, so
`... | jq` stays clean.

Idempotent: an existing `video.mp4` is not re-downloaded, existing caption files are
reused, and re-running `frames`/`scene` will not duplicate a frame that is already in
`frames/index.json` (dedupe by content hash *and* by whole-second timestamp).
`--force` re-downloads.

Time formats accepted anywhere: `9:11`, `1:02:03`, `551.5`.

## Design decisions (and the research behind them)

### Captions: yt-dlp first, ASR only as fallback
yt-dlp pulls the caption track straight from YouTube's CDN — the same text as the CC
button — and it handles signature / PO-token / bot-check churn that kills
`youtube-transcript-api` scrapers. Manual tracks are accurate; auto tracks are
almost always present but have rolling-duplicate artifacts and jargon errors.

- https://github.com/yt-dlp/yt-dlp — the tool itself, format selection and subtitle flags.
- https://skipthewatch.com/blog/yt-dlp-youtube-subtitles — CLI guide (2026): `--write-subs`
  vs `--write-auto-subs`, `--sub-langs`, `--convert-subs`, and the list of *currently
  broken* paths (`_UnsafeExtensionError` on `json3/ttml/srv*` **conversions**).
- https://github.com/yt-dlp/yt-dlp/issues/9371 — you cannot cleanly prefer manual over
  auto for the same language in one invocation, and both land under the same filename.

Consequences baked into the code:

1. **Two separate passes** (`--write-subs` into `captions/manual/`, `--write-auto-subs`
   into `captions/auto/`) so "manual vs auto" is a fact on disk, not a guess from a
   filename. Manual wins when present.
2. **Native formats, no conversion.** We request `--sub-format json3/vtt/best` and parse
   `json3`, `vtt` and `srt` ourselves. `--convert-subs json3` is a documented-broken path;
   `json3` downloaded natively is the cleanest source (per-event `tStartMs` + `segs`).
   If both passes come back empty we retry once with `--convert-subs srt` as a last resort.
3. **Rolling-caption cleanup.** YouTube auto captions repeat the previous line in each
   cue. `clean_cues()` strips the repeated prefix before merging cues into ~10 s
   segments, so `transcript.json` doesn't contain the same sentence five times.
4. **Silent failures are detected, not trusted.** yt-dlp exits 0 with no files when a
   track is missing or rate-limited; we check the directory, then fall back to ASR.

### ASR fallback: faster-whisper, `small.en`, CPU
Benchmarks put whisper.cpp/Metal ahead of faster-whisper on Apple Silicon (~10x vs ~3x
real-time, large-v3), and mlx-whisper ahead of whisper.cpp again (~2x on large-v3-turbo).
We still chose **faster-whisper** because it is the only one with a one-line `uv pip`
install, no model conversion, built-in Silero VAD, and a Python API that returns
`start/end/text` directly — exactly the shape `transcript.json` needs. The fallback runs
on `small.en` (3.4% WER, ~2 GB) because it is a *fallback*, not the primary path; speed
matters more than the last 1% of WER, and the machine is CPU-only for this runtime.

- https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison — 2026
  head-to-head: Metal vs CUDA vs CPU, model sizes/WER, and "faster-whisper has no Metal
  support on macOS".
- https://notes.billmill.org/dev_blog/2026/01/updated_my_mlx_whisper_vs_whisper.cpp_benchmark.html
  — mlx-whisper ~1.78-2x faster than whisper.cpp on the same recording.
- https://github.com/SYSTRAN/faster-whisper — API, VAD, int8.

### Frames: exact `-ss` per timestamp, `fps` filter for ranges
`ffmpeg -ss T -i in.mp4 -frames:v 1 out.png` seeks to the keyframe before `T` and decodes
forward, so the frame is accurate without decoding from zero. For a range, one pass with
`fps=1/N` is far cheaper than N invocations, and frame *k* is deterministically at
`start + k*N`, so we can name files by timestamp instead of by frame number.

### Scene detection: `select='gt(scene,THRESH)'` + `metadata=print`
`select` exposes a 0..1 scene score per frame; `metadata=mode=print:file=...` writes
`pts_time` for each selected frame, which we parse to rename the PNGs. Default 0.3 is
the documented starting point for slides/UI (0.25-0.3 if cuts are missed, 0.45-0.5 to
suppress flashes). `scdet` uses a different scale (8-14) and is only useful for
reporting scores, not for extracting stills.

- https://ffmpeg-cookbook.com/en/articles/scene-detect/ — commands, thresholds, the
  measured 16.9x-realtime decode cost, and the caveat that `select` and `scdet` scores
  are not comparable.
- https://stackoverflow.com/questions/56350321 — the `select + metadata=print` pattern.

**Known limitation:** scene detection only fires on *large* pixel changes. A slide that
persists while the cursor moves, or a scroll inside a page, will not register. That is
why `frames --range ... --every 2` exists — for a UI walkthrough, a dense time grid beats
scene detection. Run both.

### Prior art we looked at, and what we took
- https://github.com/llimllib/yt-transcribe — the `-adaptive` mode uses ffmpeg scene
  detection for slide transitions; confirmed our scene approach, but it only emits HTML
  with no per-frame transcript mapping, so we built our own index.
- https://github.com/muckybuzzwoo/claude-code-youtube-extract — chapter-aligned
  screenshots + Markdown; good model for the output shape, but it is a Claude Code
  skill, not a reusable CLI.
- https://github.com/EnragedAntelope/youtube-screenshot-extractor — blur/black-bar
  filtering and scene detection. We deliberately skip blur filtering (research frames
  should be faithful, not beautified) and keep dedupe only.

### Robustness / idempotency choices
- Fixed output names (`video.mp4`, `transcript.json`) so downstream analysis can hardcode
  paths; the raw info json is kept for provenance.
- `manifest.json` records **both** what YouTube advertised (`resolution`, from the info
  json) and what we actually downloaded (`video_file_probe`, from ffprobe).
- `frames/index.json` is the source of truth; `index.md` is regenerated from it, so
  re-running with new timestamps never loses earlier frames.
- No `git`, no external DB, no Python packages beyond the optional ASR venv.

## Gotchas worth knowing

- **Bot checks.** If YouTube decides your IP is suspicious you get
  "Sign in to confirm you're not a bot". Fixes: update yt-dlp, use browser cookies
  (`--cookies-from-browser chrome`), or a residential IP. `ytx` surfaces yt-dlp's stderr
  tail instead of failing silently.
  https://github.com/yt-dlp/yt-dlp/issues/12475
- **4K sources.** YouTube may advertise 3840x2160 while `--quality 1080` gives you
  1920x1080; that is expected, check `video_file_probe`.
- **Auto captions are not subtitles.** They are ASR output with no punctuation guarantees;
  quote them with care. `caption_source` in `transcript.json` tells you which you got.
- **`-ss` before `-i` + `-to` is ambiguous** across ffmpeg versions; we use `-t`
  (duration) instead, which is stable.

---

Part of **Software Factory** — created by Nick Kutovyy. See the repository `NOTICE` for attribution.
