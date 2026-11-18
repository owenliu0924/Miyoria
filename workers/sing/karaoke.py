"""Karaoke songs of the song worker: what ``POST /jobs`` with ``purpose: "karaoke"`` makes
(docs/design/karaoke.md §3; the format is packages/contracts/workers/src/karaoke.ts).

    <root>/_karaoke/<karaoke id>/       one karaoke song, apart from her covers: ``GET /songs``
        karaoke.m4a                     never lists it (songs.Store skips ``_`` dirs)
        karaoke.k+3.m4a                 the backing in another key, made when a singer asks (``keys``)
        reference.json                  WorkersKaraokeReference (version 2: WorkersKaraokeReferenceV2)
        meta.json                       what made it (source, lead split, lyrics, timings); written
                                        last, so a folder without it is a job that did not finish

The id is ``k-<source key>``: the same song (link, search, library file) is the same karaoke song,
whatever pitch / key / backing the request carried (karaoke reads none of them).
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

from songs import safe_id

log = logging.getLogger("miyoria.sing.karaoke")

KARAOKE_DIR = "_karaoke"
REFERENCE_FORMAT = "miyoria.karaoke.reference"
REFERENCE_VERSION = 2
BACKING_FILE = "karaoke.m4a"
REFERENCE_FILE = "reference.json"
META_FILE = "meta.json"
# Files a client may fetch from a karaoke song (karaoke.ts KARAOKE_FILES).
KARAOKE_FILES = {
    BACKING_FILE: "audio/mp4",
    REFERENCE_FILE: "application/json",
}
# The backing track: AAC in MP4, stereo, 48 kHz (what the browser's AudioContext runs at).
BACKING_RATE = 48_000
BACKING_CHANNELS = 2
BACKING_BITRATE = "128k"
PEAK = 0.89  # -1 dBFS, as the cover mix
PITCH_METHOD = "rmvpe"


def karaoke_id(source_key: str) -> str:
    return safe_id(f"k-{source_key}", 96)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class KaraokeStore:
    """The karaoke songs under ``<root>/_karaoke``."""

    def __init__(self, root: Path) -> None:
        self.root = root / KARAOKE_DIR

    def dir(self, kid: str) -> Path:
        return self.root / safe_id(kid, 96)

    def meta(self, kid: str) -> dict[str, Any] | None:
        """The song's meta.json when it is complete (both files there), else ``None``."""
        d = self.dir(kid)
        try:
            meta = json.loads((d / META_FILE).read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(meta, dict) or not all((d / f).is_file() for f in KARAOKE_FILES):
            return None
        return meta

    def write_json(self, kid: str, name: str, value: dict[str, Any]) -> None:
        """``name`` in the song's folder, whole or not at all. reference.json is compact (a 4-minute
        song's curve is 12,000 values), meta.json is for people to read."""
        d = self.dir(kid)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f"{name}.tmp"
        if name == REFERENCE_FILE:
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        else:
            text = json.dumps(value, ensure_ascii=False, indent=2)
        tmp.write_text(text, "utf-8")
        os.replace(tmp, d / name)

    def songs(self) -> list[dict[str, Any]]:
        """``job.karaoke`` of every complete karaoke song, with ``created_at``, newest first."""
        out = []
        for d in sorted(self.root.iterdir()) if self.root.is_dir() else []:
            meta = self.meta(d.name) if d.is_dir() else None
            if meta is not None:
                out.append({**summary(meta), "created_at": meta.get("created_at")})
        out.sort(key=lambda m: m.get("created_at") or "", reverse=True)
        return out


def summary(meta: dict[str, Any]) -> dict[str, Any]:
    """``job.karaoke`` (WorkersKaraokeSong) from a karaoke song's meta.json."""
    return {"id": meta["id"], "title": meta.get("title") or "", "artist": meta.get("artist"),
            "duration_s": meta.get("duration_s"), "quality": meta.get("quality")}


# ── lyrics ───────────────────────────────────────────────────────────────────


def lyric_lines(lines: Sequence[dict[str, Any]], voiced: Sequence[bool], hz: float) -> list[dict[str, Any]]:
    """The looked-up lines (start, end, text; lyricstage.py checks them) from the song's synced lines (``{"t", "text"}``, already moved by the
    lookup's overall offset). Empty lines are breaks: they end the line before them and are not
    lines themselves. A line ends where the next one (or break) starts; the last one where the lead
    last sings after it starts (``voiced``: the reference curve's voiced flags), or ``None``."""
    ordered = sorted(lines, key=lambda x: float(x["t"]))
    out = []
    for i, line in enumerate(ordered):
        text = str(line.get("text") or "").strip()
        if not text:
            continue
        start = float(line["t"])
        end = next((float(x["t"]) for x in ordered[i + 1:] if float(x["t"]) > start), None)
        if end is None:
            first = int(math.ceil(start * hz))
            last = next((j for j in range(len(voiced) - 1, first - 1, -1) if voiced[j]), None)
            end = (last + 1) / hz if last is not None else None
        out.append({"start": round(start, 3), "end": None if end is None else round(end, 3), "text": text})
    return out


def found_lines(lyrics_meta: dict[str, Any] | None, voiced: Sequence[bool], hz: float) -> list[dict[str, Any]]:
    """The looked-up lines of the lookup's result (server._lyrics_meta); none when they are not
    synced (plain lyrics have no times to show them by)."""
    if not lyrics_meta or not lyrics_meta.get("synced"):
        return []
    return lyric_lines(lyrics_meta.get("lines") or [], voiced, hz)


# ── the backing track ────────────────────────────────────────────────────────


def read_wav(p: Path):
    """(frames, channels) float32 and the rate: soundfile when it is there, else the 16-bit WAV
    reader of the standard library (what the mock writes)."""
    import numpy as np

    try:
        import soundfile as sf
    except ImportError:
        sf = None
    if sf is not None:
        x, sr = sf.read(str(p), dtype="float32", always_2d=True)
        return x, int(sr)
    with wave.open(str(p), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{p.name}: only 16-bit WAV can be read without soundfile")
        ch, sr = w.getnchannels(), w.getframerate()
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    return (raw.reshape(-1, ch).astype(np.float32) / 32768.0), sr


def mono_of(p: Path):
    x, sr = read_wav(p)
    return x.mean(axis=1), sr


def wav_seconds(p: Path) -> float | None:
    try:
        with wave.open(str(p), "rb") as w:
            return w.getnframes() / w.getframerate()
    except (OSError, EOFError, wave.Error):
        return None


def mix_parts(parts: Sequence[Path]):
    """The parts summed, stereo, cut to the shortest; (frames, 2) float32 and the rate."""
    import numpy as np

    mixed, rate = None, None
    for p in parts:
        x, sr = read_wav(p)
        if x.shape[1] == 1:
            x = np.repeat(x, 2, axis=1)
        x = x[:, :2]
        if rate is None:
            mixed, rate = x.copy(), sr
        else:
            if sr != rate:
                raise ValueError(f"{p.name} is at {sr} Hz, the backing at {rate}")
            n = min(len(mixed), len(x))
            mixed = mixed[:n] + x[:n]
    if mixed is None or rate is None:
        raise ValueError("no backing parts")
    return mixed, rate


def encode_backing(parts: Sequence[Path], out: Path, target_lufs: float = -16.0) -> dict[str, Any]:
    """The backing track into ``out`` (AAC in MP4, BACKING_BITRATE, BACKING_RATE, stereo) from its
    parts (the rest of the song after the lead; or the instrumental and the backing voices; or the
    instrumental alone), loudness-normalised to ``target_lufs`` with the peak at -1 dBFS at most, as
    the cover mix. Returns what was done."""
    import numpy as np

    from engine import JobError, loudness

    if shutil.which("ffmpeg") is None:
        raise JobError("ffmpeg is not installed: the karaoke backing cannot be encoded")
    x, sr = mix_parts(parts)
    lufs = loudness(x, sr)
    gain = 10 ** ((target_lufs - lufs) / 20) if lufs is not None else \
        0.25 / max(float(np.sqrt((x ** 2).mean())) if x.size else 0.0, 1e-6)
    peak = float(np.abs(x).max()) * gain if x.size else 0.0
    if peak > PEAK:
        gain *= PEAK / peak
    x = (x * gain).astype("<f4")
    part = out.with_name(out.stem + ".part" + out.suffix)
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "pipe:0",
           "-c:a", "aac", "-b:a", BACKING_BITRATE, "-ar", str(BACKING_RATE), "-ac", str(BACKING_CHANNELS),
           "-movflags", "+faststart", "-f", "mp4", str(part)]
    try:
        r = subprocess.run(cmd, input=np.ascontiguousarray(x).tobytes(), capture_output=True)
        if r.returncode != 0:
            raise JobError(f"ffmpeg could not encode the karaoke backing: "
                           f"{r.stderr.decode('utf-8', 'replace').strip()[:300]}")
        os.replace(part, out)
    finally:
        part.unlink(missing_ok=True)
    return {"duration_s": round(len(x) / sr, 2), "gain_db": round(20 * math.log10(max(gain, 1e-9)), 1),
            "lufs_before": None if lufs is None else round(lufs, 1), "bytes": out.stat().st_size,
            "rate": BACKING_RATE, "channels": BACKING_CHANNELS, "bitrate": BACKING_BITRATE}


# ── another key (docs/design/karaoke.md 「做了什麼第二步」) ─────────────────────────

# Semitones a singer may move the key by, either way (karaoke.ts KARAOKE_MAX_SHIFT).
KEY_MAX = 6
KEY_FILE = re.compile(r"^karaoke\.k([+-])([1-9]|1[0-2])\.m4a$")


def key_file(semitones: int) -> str:
    """The backing's file name in a key ``semitones`` away (karaoke.ts karaokeBackingName)."""
    if semitones == 0:
        return BACKING_FILE
    return f"karaoke.k{'+' if semitones > 0 else '-'}{abs(semitones)}.m4a"


def is_key_file(name: str) -> bool:
    m = KEY_FILE.match(name)
    return m is not None and int(m.group(2)) <= KEY_MAX


def shift_backing(src: Path, out: Path, semitones: int) -> str:
    """The backing track ``src`` moved by ``semitones`` into ``out`` (the same AAC settings), the
    length kept so the reference still lines up. Rubber Band (ffmpeg's ``rubberband`` filter, as a
    cover's key change); ffmpeg without it: resampling and time-stretching back (``asetrate``,
    cruder: the timbre moves with the pitch). Returns the method."""
    from engine import JobError, ffmpeg_has_filter

    if shutil.which("ffmpeg") is None:
        raise JobError("ffmpeg is not installed: the backing cannot be moved to another key")
    ratio = 2 ** (semitones / 12)
    if ffmpeg_has_filter("rubberband"):
        method, af = "rubberband", f"rubberband=pitch={ratio:.8f}:pitchq=quality:channels=together"
    else:
        method = "asetrate"
        af = f"asetrate={BACKING_RATE * ratio:.3f},aresample={BACKING_RATE},atempo={1 / ratio:.8f}"
    part = out.with_name(out.stem + ".part" + out.suffix)
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-af", af,
           "-c:a", "aac", "-b:a", BACKING_BITRATE, "-ar", str(BACKING_RATE), "-ac", str(BACKING_CHANNELS),
           "-movflags", "+faststart", "-f", "mp4", str(part)]
    try:
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode != 0:
            raise JobError(f"ffmpeg could not move the backing's key: "
                           f"{r.stderr.decode('utf-8', 'replace').strip()[:300]}")
        os.replace(part, out)
    finally:
        part.unlink(missing_ok=True)
    return method


# ── reference.json ───────────────────────────────────────────────────────────


def reference(kid: str, title: str, artist: str | None, duration_s: float, midi: list[float | None], hz: int,
              notes: list[dict[str, Any]], lyrics: dict[str, Any] | None, quality: dict[str, Any],
              notes_method: str, made: dict[str, Any] | None = None) -> dict[str, Any]:
    """``WorkersKaraokeReferenceV2``. ``made``: the lyrics stage's (``lyrics``, ``asr``, ``aligner``)."""
    m = {"lyrics": "line" if lyrics else "none", "asr": None, "aligner": None, **(made or {})}
    return {
        "format": REFERENCE_FORMAT,
        "version": REFERENCE_VERSION,
        "id": kid,
        "title": title,
        "artist": artist,
        "duration_s": round(float(duration_s), 3),
        "backing": BACKING_FILE,
        "pitch": {"hz": int(hz), "start": 0, "midi": midi},
        "notes": notes,
        "lyrics": lyrics,
        "quality": quality,
        "made": {"pitch": PITCH_METHOD, "notes": notes_method, "lyrics": m["lyrics"], "asr": m["asr"],
                 "aligner": m["aligner"]},
    }
