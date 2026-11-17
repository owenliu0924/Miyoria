"""Karaoke songs of the song worker (workers/sing/melody.py, karaoke.py and ``purpose: "karaoke"`` in
server.py): the reference melody on synthetic pitch curves, then whole jobs on the mock backend. No
GPU, no network; the only audio is the mock's few seconds of sine waves in a temporary folder."""

from __future__ import annotations

import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))

import contracts  # noqa: E402
import karaoke  # noqa: E402
import melody  # noqa: E402

HZ = melody.CURVE_HZ


def flat(midi: float, seconds: float) -> list[float]:
    return [midi] * int(round(seconds * HZ))


def gap(seconds: float) -> list[float]:
    return [math.nan] * int(round(seconds * HZ))


def cut(values: list[float]) -> list[melody.Note]:
    return melody.cut_notes(np.array(values))


# ── the curve ────────────────────────────────────────────────────────────────


def test_a_440_hz_tone_is_midi_69_in_the_right_octave():
    assert melody.to_midi(np.array([440.0, 880.0, 220.0])).tolist() == [69.0, 81.0, 57.0]
    assert math.isnan(melody.to_midi(np.array([0.0]))[0])
    f0 = np.full(200, 440.0)
    f0[80:84] = 880.0  # RMVPE jumping an octave for 40 ms
    c = melody.curve(f0)
    assert c.size == 100
    assert np.allclose(c, 69.0)


def test_two_10_ms_frames_make_one_50_hz_frame():
    nan = math.nan
    got = melody.downsample(np.array([60.0, nan, nan, nan, 60.0, 62.0, nan, 61.0, 64.0]))
    assert got[0] == 60.0 and math.isnan(got[1]) and got[2] == 61.0 and got[3] == 61.0 and got[4] == 64.0
    assert melody.curve_json(got) == [60.0, None, 61.0, 61.0, 64.0]
    # Cut or padded to the backing track's length, unvoiced past the pitch track's end.
    c = melody.curve(np.full(10, 440.0), frames=8, clean=False)
    assert melody.curve_json(c) == [69.0] * 5 + [None] * 3
    assert melody.curve(np.full(10, 440.0), frames=3, clean=False).size == 3
    assert melody.curve_json(np.array([60.123456])) == [60.12]


def test_frames_far_below_the_leads_loudness_are_unvoiced():
    f0 = np.full(300, 440.0)
    rms = np.concatenate([np.full(200, 0.1), np.full(50, 0.01), np.full(50, 0.001)])  # 0, -20, -40 dB
    gated = melody.gate_by_loudness(f0, rms)
    assert (gated[:250] == 440.0).all() and (gated[250:] == 0.0).all()
    # Unvoiced frames do not count towards the typical loudness: silence around the singing does
    # not lower it.
    quiet_around = np.concatenate([np.zeros(300), f0])
    rms_around = np.concatenate([np.full(300, 1e-5), rms])
    assert (melody.gate_by_loudness(quiet_around, rms_around)[300:] == gated).all()
    assert (melody.gate_by_loudness(f0, None) == f0).all()


def test_the_rms_frames_line_up_with_rmvpes():
    sr = 16_000
    t = np.arange(sr) / sr
    x = 0.5 * np.sin(2 * math.pi * 220 * t)
    r = melody.frame_rms(x, sr)
    assert r.size == sr // 160 + 1
    assert np.allclose(r[5:-5], 0.5 / math.sqrt(2), rtol=0.02)
    x[: sr // 2] = 0.0
    r = melody.frame_rms(x, sr)
    assert r[40] == 0.0 and r[60] > 0.3


# ── the notes ────────────────────────────────────────────────────────────────


def test_a_sine_sweep_gives_short_notes_only():
    seconds = 6.0
    n = int(seconds * HZ)
    sweep = (48.0 + 24.0 * np.arange(n) / n).tolist()  # two octaves, 4 semitones a second
    notes = cut(sweep)
    assert len(notes) >= 15
    assert max(n.end - n.start for n in notes) <= 0.6
    assert all(n.end - n.start <= melody.MAX_NOTE_S for n in notes)
    assert [n.midi for n in notes] == sorted(n.midi for n in notes)
    # Slower: one semitone a second; still no long flat note.
    slow = (60.0 + np.arange(n) / HZ).tolist()
    assert max(n.end - n.start for n in cut(slow)) <= 1.6


def test_steps_with_short_silent_gaps_are_one_note_each():
    pitches = [60.0, 64.0, 67.0, 72.0, 67.0, 65.0]
    values: list[float] = []
    for i, p in enumerate(pitches):
        values += flat(p, 0.5)
        values += gap(0.06 if i % 2 else 0.1)
    notes = cut(values)
    assert [n.midi for n in notes] == pitches
    assert all(n.end - n.start == pytest.approx(0.5) for n in notes)
    assert all(n.json()["source"] == "pitch" and n.json()["line"] is None and n.json()["char"] is None for n in notes)
    # Legato: no gap at all, still one note a step.
    legato = sum((flat(p, 0.4) for p in pitches), [])
    assert [n.midi for n in cut(legato)] == pitches


def test_a_consonant_gap_at_the_same_pitch_is_bridged_and_a_long_one_is_not():
    for gap_s in (0.04, 0.08, 0.12):
        notes = cut(flat(62.0, 0.5) + gap(gap_s) + flat(62.0, 0.5))
        assert len(notes) == 1, gap_s
        assert notes[0].end - notes[0].start == pytest.approx(1.0 + gap_s)
    for gap_s in (0.14, 0.3):
        notes = cut(flat(62.0, 0.5) + gap(gap_s) + flat(62.0, 0.5))
        assert len(notes) == 2, gap_s
        assert notes[1].start - notes[0].end == pytest.approx(gap_s)
    # Bridged only at the same pitch.
    assert [n.midi for n in cut(flat(62.0, 0.5) + gap(0.06) + flat(63.0, 0.5))] == [62.0, 63.0]


def test_a_held_tone_is_split_into_parts_no_longer_than_the_maximum():
    notes = cut(flat(69.0, 9.0))
    assert len(notes) == 3
    assert all(n.end - n.start == pytest.approx(3.0) for n in notes)
    assert notes[0].start == 0.0 and notes[-1].end == pytest.approx(9.0)
    assert all(a.end == b.start for a, b in zip(notes, notes[1:]))
    assert all(n.midi == 69.0 for n in notes)
    assert all(n.end - n.start <= melody.MAX_NOTE_S for n in cut(flat(69.0, 4.02)))


def test_a_blip_is_dropped_and_a_short_note_is_kept():
    assert cut(gap(0.5) + flat(70.0, 0.06) + gap(0.5)) == []
    kept = cut(gap(0.5) + flat(70.0, 0.08) + gap(0.5))
    assert len(kept) == 1 and kept[0].start == pytest.approx(0.5) and kept[0].midi == 70.0


def test_vibrato_and_a_short_scoop_stay_in_the_note():
    t = np.arange(int(2.0 * HZ)) / HZ
    vibrato = (64.0 + 0.5 * np.sin(2 * math.pi * 6.0 * t)).tolist()
    notes = cut(vibrato)
    assert len(notes) == 1 and notes[0].midi == pytest.approx(64.0, abs=0.1)
    # 40 ms a semitone below before the note: shorter than the hold, part of the note it leads into.
    scoop = flat(63.0, 0.04) + flat(64.0, 1.0)
    assert len(cut(scoop)) == 1


def test_the_note_pitch_is_the_median_of_the_curve():
    values = flat(60.0, 0.3) + [60.2] * 5 + flat(60.0, 0.3)
    assert cut(values)[0].midi == 60.0
    assert melody.cut_notes([None, None] + [61.0] * 10 + [None])[0].start == pytest.approx(0.04)


# ── quality ──────────────────────────────────────────────────────────────────


def test_quality_needs_enough_voice_and_enough_notes():
    voiced = np.array([60.0] * 15 + [math.nan] * 85)
    q = melody.quality(voiced, 30, True)
    assert q == {"ok": True, "reason": None, "voiced_ratio": 0.15, "notes": 30, "lead_split": True}
    q = melody.quality(voiced, 29, False)
    assert q["ok"] is False and q["reason"] == "only 29 notes (needs 30)" and q["lead_split"] is False
    q = melody.quality(np.array([60.0] * 14 + [math.nan] * 86), 40, True)
    assert q["ok"] is False and "voiced in 14%" in q["reason"]
    q = melody.quality(np.array([math.nan] * 10), 0, True)
    assert q["ok"] is False and "voiced" in q["reason"] and "notes" in q["reason"]
    assert melody.quality(np.array([60.0] * 5), 2, True, min_voiced=0.5, min_notes=2)["ok"] is True
    contracts.WorkersKaraokeQuality.model_validate(q, strict=True)


# ── lyrics lines ─────────────────────────────────────────────────────────────


def test_lyric_lines_end_where_the_next_starts_or_where_the_lead_stops():
    voiced = [False] * 50 + [True] * 200 + [False] * 100  # the lead sings from 1 s to 5 s
    lines = [{"t": 0.5, "text": "one"}, {"t": 2.0, "text": "two"}, {"t": 3.0, "text": ""},
             {"t": 3.5, "text": "three"}, {"t": 3.5, "text": "three again"}]
    got = karaoke.lyric_lines(lines, voiced, HZ)
    assert [(x["start"], x["end"], x["text"]) for x in got] == [
        (0.5, 2.0, "one"), (2.0, 3.0, "two"), (3.5, 5.0, "three"), (3.5, 5.0, "three again")]
    assert all(x["check"] == "unchecked" and x["confidence"] is None and x["chars"] is None for x in got)
    # Nothing sung after the last line starts: nothing tells where it ends.
    assert karaoke.lyric_lines([{"t": 6.0, "text": "late"}], voiced, HZ)[0]["end"] is None
    block = karaoke.lyrics_block({"provider": "lrclib", "synced": True, "lines": lines}, voiced, HZ)
    assert block is not None and block["timing"] == "line" and block["provider"] == "lrclib"
    contracts.WorkersKaraokeLyrics.model_validate(block, strict=True)
    assert karaoke.lyrics_block({"provider": "lrclib", "synced": False, "lines": []}, voiced, HZ) is None
    assert karaoke.lyrics_block(None, voiced, HZ) is None


def test_the_reference_is_the_contracts_format():
    midi = melody.curve_json(np.array(flat(60.0, 1.0) + gap(0.2)))
    notes = [n.json() for n in cut(flat(60.0, 1.0))]
    q = melody.quality(np.array(flat(60.0, 1.0)), len(notes), True)
    ref = karaoke.reference("k-x", "T", None, 1.2, midi, HZ, notes, None, q, melody.NOTES_METHOD)
    parsed = contracts.WorkersKaraokeReference.model_validate_json(json.dumps(ref), strict=True)
    assert parsed.made.model_dump() == {"pitch": "rmvpe", "notes": "pitch-runs-1", "lyrics": "none"}
    assert ref["pitch"] == {"hz": 50, "start": 0, "midi": midi} and len(midi) == 60
    assert karaoke.karaoke_id("yt-abc") == "k-yt-abc"


def test_hostd_is_asked_to_share_for_a_karaoke_job(tmp_path):
    import lease
    from gpu import Profile

    arb = lease.HostdArbitration(lambda: None, Profile(tmp_path), stage_pauses=lambda s: False,
                                 stage_uses_gpu=lambda s: True, queued=lambda job: ["behind"],
                                 call=lambda *a: None)

    def job(purpose: str) -> SimpleNamespace:
        req = SimpleNamespace(purpose=purpose, exclusive_ack=False)
        return SimpleNamespace(id="j1", request=req, gpu=lease.LeaseJob("j1", 10.0))

    p = arb._params(job("karaoke"), "reference", False, False)
    assert p["mode"] == "share" and p["queued"] == [] and p["pauses"] is False
    p = arb._params(job("cover"), "convert", False, False)
    assert p["mode"] == "exclusive" and p["queued"] == ["behind"]


# ── whole jobs on the mock backend ───────────────────────────────────────────


@pytest.fixture(scope="module")
def worker(tmp_path_factory):
    root = tmp_path_factory.mktemp("songs-karaoke")
    os.environ.update({"SING_BACKEND": "mock", "SING_DATA_DIR": str(root), "SING_MOCK_SECONDS": "3"})
    server = sys.modules.get("sing_server")
    if server is None:
        spec = importlib.util.spec_from_file_location("sing_server", SING / "server.py")
        assert spec and spec.loader
        server = importlib.util.module_from_spec(spec)
        sys.modules["sing_server"] = server
        spec.loader.exec_module(server)
    from fastapi.testclient import TestClient

    with TestClient(server.app) as c:
        yield c, server, root
    shutil.rmtree(root, ignore_errors=True)


def wait(client, job_id: str) -> dict:
    t0 = time.time()
    while time.time() - t0 < 120:
        job = client.get(f"/jobs/{job_id}").json()["job"]
        if job["state"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def karaoke_job(client, query: str, **kw) -> dict:
    r = client.post("/jobs", json={"query": query, "purpose": "karaoke", **kw})
    assert r.status_code == 200, r.text
    return wait(client, r.json()["job"]["id"])


def probe(p: Path) -> dict | None:
    """ffprobe's view of the first audio stream, ``None`` without ffprobe."""
    if shutil.which("ffprobe") is None:
        return None
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                        "stream=codec_name,sample_rate,channels:format=format_name,duration", "-of", "json", str(p)],
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_a_karaoke_job_makes_a_backing_track_and_a_reference(worker):
    client, server, root = worker
    b = server.state.backend
    converts, mixes = len(b.convert_inputs), len(b.mix_inputs)
    done = karaoke_job(client, "karaoke tune")
    assert done["state"] == "done", done
    assert done["song_id"] is None and done["song"] is None and done["cached"] is False
    assert done["request"]["purpose"] == "karaoke"
    k = done["karaoke"]
    key = done["source"]["key"]
    assert k["id"] == f"k-{key}" and k["title"] == "karaoke tune" and k["artist"] == "Mock Artist"
    assert k["duration_s"] == pytest.approx(3.0, abs=0.01)
    # The mock's tune is 3 s of a scale: a melody, but far too few notes to offer.
    q = k["quality"]
    assert q["ok"] is False and q["reason"].startswith("only ") and q["lead_split"] is True
    assert q["voiced_ratio"] > 0.7
    # The lead from the song, RMVPE on it; no conversion, no mix; the backing is the song without the lead.
    assert len(b.convert_inputs) == converts and len(b.mix_inputs) == mixes
    assert b.karaoke_f0_inputs[-1] == ("lead.wav", "cpu")
    assert b.karaoke_parts[-1] == ["rest.wav"]
    folder = root / "_karaoke" / k["id"]
    assert sorted(p.name for p in folder.iterdir()) == ["karaoke.m4a", "meta.json", "reference.json"]

    # reference.json, as served (tests/response_contract.py holds it to WorkersKaraokeReference too).
    r = client.get(f"/karaoke/{k['id']}/files/reference.json")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    ref = contracts.WorkersKaraokeReference.model_validate_json(r.content, strict=True)
    assert ref.format == "miyoria.karaoke.reference" and ref.version == 1 and ref.id == k["id"]
    assert ref.backing == "karaoke.m4a" and ref.duration_s == pytest.approx(3.0, abs=0.01)
    assert ref.pitch.hz == 50 and ref.pitch.start == 0 and len(ref.pitch.midi) == 150
    voiced = [m for m in ref.pitch.midi if m is not None]
    assert set(voiced) <= {60.0, 62.0, 64.0, 65.0, 67.0, 69.0, 71.0, 72.0}
    # 0.3 s a note, 60 ms between: the ninth starts at 2.88 s and is cut by the end at 3 s.
    assert [n.midi for n in ref.notes] == [60.0, 62.0, 64.0, 65.0, 67.0, 69.0, 71.0, 72.0, 71.0]
    assert len(ref.notes) == 9 == q["notes"]
    assert all(n.source == "pitch" and n.line is None and n.char is None for n in ref.notes)
    assert all(0.28 <= n.end - n.start <= 0.32 for n in ref.notes[:-1])
    assert ref.notes[-1].end == pytest.approx(3.0) and ref.notes[0].start == 0.0
    assert ref.made.model_dump() == {"pitch": "rmvpe", "notes": "pitch-runs-1", "lyrics": "line"}
    assert ref.quality.model_dump() == q
    lines = ref.lyrics.lines if ref.lyrics else []
    assert ref.lyrics is not None and ref.lyrics.provider == "mock" and ref.lyrics.timing == "line"
    assert [x.text for x in lines] == ["mock line 1", "mock line 2", "mock line 3"]
    assert [a.end for a in lines[:-1]] == [b.start for b in lines[1:]] and lines[-1].end is not None
    assert all(x.check == "unchecked" and x.chars is None for x in lines)

    # The backing track.
    r = client.get(f"/karaoke/{k['id']}/files/karaoke.m4a")
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mp4"
    assert r.content[4:8] == b"ftyp"
    info = probe(folder / "karaoke.m4a") if shutil.which("ffmpeg") else None
    if info is not None:
        stream = info["streams"][0]
        assert (stream["codec_name"], stream["sample_rate"], stream["channels"]) == ("aac", "48000", 2)
        assert float(info["format"]["duration"]) == pytest.approx(3.0, abs=0.1)
    meta = json.loads((folder / "meta.json").read_text("utf-8"))
    assert meta["backing"]["parts"] == ["rest.wav"] and meta["source"]["key"] == key
    assert list(meta["timings"])[:3] == ["resolve_s", "download_s", "lead_s"]
    assert "reference_s" in meta["timings"] and "encode_s" in meta["timings"]

    # Not one of her songs.
    assert all(not s["id"].startswith("k-") and s["title"] != "karaoke tune"
               for s in client.get("/songs").json()["songs"])
    assert client.get(f"/songs/{k['id']}").status_code == 404
    listed = client.get("/karaoke").json()["karaoke"]
    assert [s["id"] for s in listed] == [k["id"]] and listed[0]["created_at"]

    # Asked again: answered from the karaoke songs at once; forced: made again.
    again = client.post("/jobs", json={"query": "karaoke tune", "purpose": "karaoke"}).json()["job"]
    assert again["state"] == "done" and again["cached"] is True and again["karaoke"] == k
    calls = len(b.karaoke_f0_inputs)
    forced = karaoke_job(client, "karaoke tune", force=True)
    assert forced["cached"] is False and forced["karaoke"]["id"] == k["id"]
    assert len(b.karaoke_f0_inputs) == calls + 1


def test_a_cover_of_the_same_song_is_unchanged_and_reuses_the_stems(worker):
    client, server, _root = worker
    b = server.state.backend
    k = karaoke_job(client, "shared stems")["karaoke"]
    leads = len(b.lead_devices)
    r = client.post("/jobs", json={"query": "shared stems"})
    done = wait(client, r.json()["job"]["id"])
    assert done["state"] == "done", done
    assert done["karaoke"] is None and done["song_id"] and not done["song_id"].startswith("k-")
    song = done["song"]
    assert song["lead_split"] == {"used": True, "cached": True} and len(b.lead_devices) == leads
    # Downloaded, split and kept by the karaoke job: the cover only converts and mixes.
    assert list(song["timings"])[:3] == ["resolve_s", "convert_s", "mix_s"] and b.convert_inputs[-1] == "lead.wav"
    assert [s["id"] for s in client.get("/songs").json()["songs"]].count(song["id"]) == 1
    assert k["id"] not in [s["id"] for s in client.get("/songs").json()["songs"]]
    # The karaoke song asked for again after the cover is still the same one.
    assert client.post("/jobs", json={"query": "shared stems", "purpose": "karaoke"}).json()["job"]["cached"] is True


def test_without_a_lead_split_the_backing_is_the_instrumental(worker, monkeypatch):
    client, server, _root = worker
    b = server.state.backend
    monkeypatch.setenv("SING_MOCK_LEAD_MODEL", "0")
    done = karaoke_job(client, "karaoke no split")
    assert done["state"] == "done", done
    assert done["karaoke"]["quality"]["lead_split"] is False
    assert b.karaoke_f0_inputs[-1][0] == "vocals.wav" and b.karaoke_parts[-1] == ["instrumental.wav"]


def test_the_quality_thresholds_can_be_set(worker, monkeypatch):
    client, _server, _root = worker
    monkeypatch.setenv("SING_KARAOKE_MIN_NOTES", "5")
    q = karaoke_job(client, "karaoke lenient")["karaoke"]["quality"]
    assert q == {"ok": True, "reason": None, "voiced_ratio": q["voiced_ratio"], "notes": 9, "lead_split": True}
    monkeypatch.setenv("SING_KARAOKE_MIN_VOICED", "0.95")
    q = karaoke_job(client, "karaoke strict")["karaoke"]["quality"]
    assert q["ok"] is False and "voiced in" in q["reason"]


def test_karaoke_files_are_only_the_two_and_only_of_finished_songs(worker):
    client, _server, root = worker
    k = karaoke_job(client, "karaoke files")["karaoke"]
    for name in ("meta.json", "lyrics.lrc", "../meta.json", "mix.wav"):
        assert client.get(f"/karaoke/{k['id']}/files/{name}").status_code == 404, name
    assert client.get("/karaoke/nosuch/files/reference.json").status_code == 404
    assert client.get("/karaoke/..%2F..%2F_sources/files/reference.json").status_code == 404
    # A song still being made (no meta.json yet) serves nothing.
    unfinished = root / "_karaoke" / "k-unfinished"
    unfinished.mkdir(parents=True)
    for name in ("reference.json", "karaoke.m4a"):
        (unfinished / name).write_bytes(b"{}")
    assert client.get("/karaoke/k-unfinished/files/reference.json").status_code == 404
    assert "k-unfinished" not in [s["id"] for s in client.get("/karaoke").json()["karaoke"]]
    shutil.rmtree(unfinished)


def test_karaoke_songs_take_part_in_the_cache_cleanup(worker, monkeypatch):
    client, server, root = worker
    k = karaoke_job(client, "karaoke to clean")["karaoke"]
    key = k["id"][2:]
    cache = server.state.cache
    assert client.get("/cache").json()["karaoke"] >= 1
    # Used just now: it stays.
    from cache import CacheLimits

    out = cache.prune(dry_run=True, limits=CacheLimits(max_bytes=1, max_days=14, protect_hours=6))
    assert ("karaoke", k["id"]) not in {(r["kind"], r["id"]) for r in out["removed"]}
    # Old enough and not protected: the karaoke song goes, and its download once nothing needs it.
    later = time.time() + 30 * 86400
    monkeypatch.setattr(cache, "clock", lambda: later)
    out = cache.prune(dry_run=True, limits=CacheLimits(max_bytes=0, max_days=14, protect_hours=6))
    removed = {(r["kind"], r["id"]) for r in out["removed"]}
    assert ("karaoke", k["id"]) in removed
    assert ("source", key) in removed
    assert out["removed_karaoke"] >= 1
