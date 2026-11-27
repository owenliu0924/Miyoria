# Generated, do not edit. Made from packages/contracts/schema/workers.json by
#     python workers/gen_contracts.py
# with datamodel-code-generator 0.96.0 (pinned in workers/requirements-contracts.txt).
# To change a model, change its zod schema in packages/contracts/workers/src, run
# `pnpm contracts:gen`, then the command above.

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel, confloat, conint, constr


class WorkersAsrHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str
    model: str | None = None
    device: str | None = None
    backend: str | None = None
    offloaded: bool
    loading: bool
    released_mb: float | None
    since: float | None = None
    reason: str | None = None
    reload_at: float | None = None
    vram_allocated_mb: float | None = None
    device_total_mb: float | None = None
    device_used_mb: float | None = None
    device_free_mb: float | None = None


class WorkersAsrReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    text: str
    language: str | None = None
    emotion: str | None = None
    audio_events: list[str] = []
    duration_ms: float | None = None


class WorkersBusy(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    busy: conint(ge=0, le=9007199254740991)


class WorkersError(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    error: str


class WorkersHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str


class WorkersKaraokeChar(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    text: str
    start: float
    end: float


class WorkersKaraokeKeyReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    file: str
    semitones: conint(ge=-9007199254740991, le=9007199254740991)
    cached: bool
    method: str


class WorkersKaraokeKeyRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    semitones: conint(ge=-6, le=6)


class WorkersKaraokeLine(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    start: float
    end: float | None
    text: str
    check: Literal["unchecked", "matched", "uncertain", "failed"]
    confidence: float | None
    chars: list[WorkersKaraokeChar] | None


class WorkersKaraokeLyrics(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    provider: str | None
    timing: Literal["line", "char"]
    lines: list[WorkersKaraokeLine]


class WorkersKaraokeLyricsCheck(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    matched: conint(ge=-9007199254740991, le=9007199254740991)
    uncertain: conint(ge=-9007199254740991, le=9007199254740991)
    failed: conint(ge=-9007199254740991, le=9007199254740991)
    verdict: Literal["kept", "doubtful", "wrong_song", "unchecked"]


class WorkersKaraokeLyricsOptions(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    aligner: Literal["w2v", "mms"] = "mms"
    matched: confloat(ge=0.0, le=1.0) = 0.75
    uncertain: confloat(ge=0.0, le=1.0) = 0.5
    keep_share: confloat(ge=0.0, le=1.0) = 0.5
    wrong_share: confloat(ge=0.0, le=1.0) = 0.2


class WorkersKaraokeMade(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    pitch: str
    notes: str
    lyrics: str


class WorkersKaraokeMadeV2(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    pitch: str
    notes: str
    lyrics: str
    asr: str | None
    aligner: str | None


class WorkersKaraokeNote(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    start: float
    end: float
    midi: float
    source: Literal["pitch", "lyric"]
    line: conint(ge=-9007199254740991, le=9007199254740991) | None
    char: conint(ge=-9007199254740991, le=9007199254740991) | None


class WorkersKaraokePiece(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    text: str
    sung: bool
    start: float | None
    end: float | None
    reading: str | None
    roman: str | None


class WorkersKaraokePitch(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    hz: conint(le=9007199254740991, gt=0)
    start: float
    midi: list[float | None]


class WorkersKaraokeQuality(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    ok: bool
    reason: str | None
    voiced_ratio: float
    notes: conint(ge=-9007199254740991, le=9007199254740991)
    lead_split: bool


class WorkersKaraokeReferenceV1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    format: Literal["miyoria.karaoke.reference"]
    version: Literal[1]
    id: str
    title: str
    artist: str | None
    duration_s: float
    backing: str
    pitch: WorkersKaraokePitch
    notes: list[WorkersKaraokeNote]
    lyrics: WorkersKaraokeLyrics | None
    quality: WorkersKaraokeQuality
    made: WorkersKaraokeMade


class WorkersKaraokeSong(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: str
    title: str
    artist: str | None
    duration_s: float | None
    quality: WorkersKaraokeQuality | None
    video: bool = False


class WorkersKaraokeStreamChunk(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    stream: constr(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    at: conint(ge=0, le=9007199254740991)
    audio: str
    end: bool = False


class WorkersKaraokeStreamFrames(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    stream: str
    from_: conint(ge=0, le=9007199254740991) = Field(..., alias="from")
    midi: list[float | None]
    final: bool
    seconds: float
    level_db: float | None
    floor_db: float | None


class WorkersKaraokeStreamRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    room: constr(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    chunks: list[WorkersKaraokeStreamChunk] = Field(..., max_length=8)
    drop: list[constr(pattern=r"^[A-Za-z0-9_-]{1,64}$")] = Field([], max_length=8)


class WorkersKaraokeVoicePitch(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    hz: Literal[50]
    midi: list[float | None]
    seconds: float
    level_db: float | None
    floor_db: float | None
    device: str
    method: str


class WorkersLyricsHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    ok: bool


class WorkersLyricsHints(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    key: str | None = None
    raw_title: str | None = None
    title: str | None = None
    artist: str | None = None
    uploader: str | None = None
    channel: str | None = None
    track: str | None = None
    meta_artist: str | None = None
    alt_title: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    duration: float | None = None
    url: str | None = None


class Matched(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    query: str
    duration_s: float | None


class WorkersLyricsResult(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    provider: str
    synced: bool
    lrc: str | None
    plain: str | None
    track: str | None
    artist: str | None
    how: str
    confidence: float
    matched: Matched
    checks: dict[str, Any]
    tried: conint(ge=-9007199254740991, le=9007199254740991)
    llm: dict[str, Any] | None


class WorkersOffloadReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    state: Literal["offloaded", "reloading"]
    offload_ms: float
    already: bool | None = None
    cancelled_reload: bool | None = None
    drained: bool | None = None
    vram_before_mb: float | None = None
    vram_after_mb: float | None = None
    device_used_before_mb: float | None = None
    device_used_after_mb: float | None = None
    released_mb: float | None = None
    since: float | None = None
    reason: str | None = None
    reload_at: float | None = None


class WorkersOffloadRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    reason: str | None = None
    max_s: float | None = None


class WorkersReloadReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    state: Literal["ready", "offloaded"]
    reload_ms: float | None = None
    already: bool | None = None
    cancelled: bool | None = None
    vram_mb: float | None = None
    device_total_mb: float | None = None
    device_used_mb: float | None = None
    device_free_mb: float | None = None


class WorkersSandboxEndReason(
    RootModel[
        Literal[
            "closed",
            "idle",
            "lifetime",
            "lease",
            "disk",
            "lost",
            "shutdown",
            "host_policy",
        ]
    ]
):
    root: Literal[
        "closed", "idle", "lifetime", "lease", "disk", "lost", "shutdown", "host_policy"
    ]


class Ended(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    reason: Literal[
        "closed", "idle", "lifetime", "lease", "disk", "lost", "shutdown", "host_policy"
    ]
    at: float


class WorkersSandboxEvent1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    seq: float
    job: str
    kind: Literal["state"]
    state: Literal["starting", "ready", "busy", "ended"]


class WorkersSandboxEvent2(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    seq: float
    job: str
    kind: Literal["cpu"]
    cpu_ms: float


class WorkersSandboxEvent3(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    seq: float
    job: str
    exec: str
    kind: Literal["stdout", "stderr"]
    text: str


class WorkersSandboxEvent5(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    seq: float
    job: str
    proc: str
    kind: Literal["proc_out"]
    stream: Literal["stdout", "stderr"]
    offset: float
    data_b64: str


class WorkersSandboxEvent6(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    seq: float
    job: str
    proc: str
    kind: Literal["proc_exit"]
    code: float | None
    signal: str | None


class Program(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    language: Literal["python", "node", "shell"]
    code: str


class Output(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    keep_bytes: float
    kill_bytes: float
    stream_bytes: float


class Collect(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    max_files: float
    max_bytes: float


class WorkersSandboxFileIn(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    path: str
    content: str
    encoding: Literal["utf8", "base64"] | None = None


class WorkersSandboxFileOut(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    path: str
    size: float
    encoding: Literal["utf8", "base64"]
    content: str


class Docker(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    available: bool
    server_version: str | None
    error: str | None
    cgroup: Literal["v2", "v1"] | None
    runtime: str | None


class Images(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    tag: str
    present: bool
    building: bool
    stale: bool


class Policy(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    members: bool
    plugins: bool
    cpus: float
    memory_mb: float
    disk_mb: float
    max_job_cpus: float
    max_job_memory_mb: float


class Load(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    jobs: float
    running: float
    queued: float
    cpus: float
    memory_mb: float
    disk_mb: float


class WorkersSandboxInfo(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    api: Literal[1]
    service_version: str
    boot: str
    platform: str
    arch: str
    docker: Docker
    images: dict[Literal["default", "browser"], Images]
    ready: bool
    reason: str | None = None
    policy: Policy
    load: Load


class Mounts(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    tools: bool
    ext: bool


class Refused(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    address: float
    port: float
    cap: float


class Egress(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    bytes_in: float
    bytes_out: float
    connections: float
    refused: Refused


class WorkersSandboxJobUsage(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    cpu_ms: float
    cpu_source: Literal["cgroup", "sampled"]
    wall_ms: float
    disk_bytes: float
    egress: Egress


class WorkersSandboxLimits(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    cpus: float
    memory_mb: float
    pids: float
    tmp_mb: float
    file_mb: float
    nofile: float
    disk_mb: float


class WorkersSandboxManifestEntry(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    path: str
    size: float
    sha256: str
    mtime_ms: float


class WorkersSandboxNetwork(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    mode: Literal["open", "allowlist", "none"]
    allow: list[str]
    deny_ports: list[conint(ge=-9007199254740991, le=9007199254740991)]
    max_connections: float
    max_mb: float


class WorkersSandboxProcStart(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    argv: list[str]
    cwd: Literal["/work", "/workspace", "/ext"] | None = None
    env: dict[str, str] | None = None


class SkippedItem(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    path: str
    why: str


class Tar(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    bytes: float
    sha256: str


class WorkersSandboxSyncResult(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    changed: list[WorkersSandboxManifestEntry]
    deleted: list[str]
    skipped: list[SkippedItem]
    tar: Tar | None


class WorkersSandboxSyncStart(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    target: Literal["workspace"]


class WorkersSandboxUploadCommit(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    parts: conint(ge=-9007199254740991, le=9007199254740991)
    bytes: float
    sha256: str
    format: Literal["tar", "tar.gz"]
    target: Literal["workspace", "tools", "ext", "work"]
    replace: bool
    manifest: list[WorkersSandboxManifestEntry]


class WorkersSandboxUploadPartResult(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    n: conint(ge=-9007199254740991, le=9007199254740991)
    bytes: float
    sha256: str


class WorkersSandboxUploadResult(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    files: float
    bytes: float
    skipped: list[SkippedItem]


class WorkersSingGpuContext(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    in_voice: bool = False
    listeners: conint(ge=0, le=9007199254740991) = 0
    live: bool = False
    urgent: list[str] = Field([], max_length=200)


class WorkersSingGpuStatus(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    policy: str
    stage: str
    mode: str | None
    code: str | None
    reason: str | None
    free_mb: float | None
    total_mb: float | None
    need_mb: float | None
    step_s: float | None
    baseline_s: float | None
    spilling: bool
    spills: float
    waited_s: float
    silenced_s: float
    silence_est_s: float | None
    silence_max_s: float | None


class Audience(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    in_voice: bool
    listeners: float
    live: bool
    age_s: float | None
    fresh: bool


class Gpu(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    policy: str
    policy_source: str | None = None
    cuda: bool
    total_mb: float | None
    free_mb: float | None
    headroom_mb: float | None = None
    audience: Audience
    learned: dict[str, Any]
    job: WorkersSingGpuStatus | None


class WorkersSingHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str
    model: str | None = None
    device: str | None = None
    backend: str | None = None
    busy: bool | None = None
    queued: conint(ge=-9007199254740991, le=9007199254740991) | None = None
    vram_allocated_mb: float | None = None
    gpu: Gpu | None = None


class Source(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    title: str
    artist: str | None


class WorkersSingJobRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    query: constr(max_length=200) | None = None
    url: constr(max_length=500) | None = None
    path: constr(max_length=300) | None = None
    title: constr(max_length=120) | None = None
    artist: constr(max_length=120) | None = None
    pitch: conint(ge=-24, le=24) | None = None
    key: conint(ge=-12, le=12) = 0
    backing: Literal["keep", "drop", "convert", "acapella"] = "keep"
    force: bool = False
    exclusive_ack: bool = False
    purpose: Literal["cover", "karaoke"] = "cover"
    karaoke_lyrics: WorkersKaraokeLyricsOptions | None = None
    karaoke_video: bool = True


class WorkersSingLibraryEntry(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    path: str
    title: str
    artist: str | None
    split: bool


class WorkersSingLyricLine(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    t: float
    text: str


class Previous(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    provider: str | None
    track: str | None


class WorkersSingLyricsReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    found: bool
    previous: Previous | None = None
    kept: bool | None = None
    lyrics: dict[str, Any] | None = None
    lines: conint(ge=-9007199254740991, le=9007199254740991) | None = None


class WorkersSingLyricsRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    title: constr(max_length=200) | None = None
    artist: constr(max_length=200) | None = None
    fresh: bool = False


class WorkersSingOk(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    ok: bool


class WorkersSingPruneRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    dry_run: bool = False


class Lyrics(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    synced: bool
    lines: list[WorkersSingLyricLine]


class Play(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    sample_rate: conint(le=9007199254740991, gt=0)
    samples: conint(ge=-9007199254740991, le=9007199254740991) | None


class Video(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    file: str


class Source1(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    kind: str
    url: str | None


class Beats(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    bpm: float
    times: list[float]


class WorkersSingSongMeta(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: str
    title: str
    artist: str | None
    duration_s: float | None
    lyrics: Lyrics | None
    play: Play
    pitch: dict[str, Any]
    timings: dict[str, float]
    peak_vram_mb: float | None
    has_video: bool
    video: Video | None
    source: Source1 | None = None
    backing: str | None = None
    beats: Beats | None = None


class WorkersSingSongReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    song: WorkersSingSongMeta


class WorkersSingSongsReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    songs: list[WorkersSingSongMeta]


class WorkersTtsHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str
    offloaded: bool
    model: str | None = None
    device: str | None = None
    mode: str | None = None
    backend: str | None = None
    sample_rate: conint(ge=-9007199254740991, le=9007199254740991) | None = None
    streaming: bool | None = None
    chunk_size: conint(ge=-9007199254740991, le=9007199254740991) | None = None
    stream_probe: list[str] | None = None
    voices: list[str] | None = None
    instruct_supported: bool | None = None
    clone_mode: str | None = None
    voice_bank: bool | None = None
    released_mb: float | None = None
    engine_pid: conint(ge=-9007199254740991, le=9007199254740991) | None = None
    loading: bool | None = None
    since: float | None = None
    reason: str | None = None
    reload_at: float | None = None
    vram_allocated_mb: float | None = None
    device_total_mb: float | None = None
    device_used_mb: float | None = None
    device_free_mb: float | None = None


class WorkersTtsOffloadRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    reason: str | None = None
    max_s: float | None = None
    drain_s: float | None = None


class WorkersTtsRequest(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    text: str
    language: str | None = None
    emotion: str | None = None
    instruct: str | None = None
    voice: str | None = None
    priority: str | None = None


class WorkersTtsVoice(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    name: str
    ref_text: str | None
    x_vector_only: bool
    references: list[str]


class WorkersTtsVoices(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    mode: str
    default: str | None
    clone_mode: str
    voice_bank: bool
    voices: list[WorkersTtsVoice]


class WorkersTurnHealth(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    status: str
    smart_turn: bool
    silero: bool
    threshold: float
    errors: dict[str, str]


class WorkersTurnReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    complete: bool
    probability: float
    inference_ms: float | None = None


class WorkersKaraokeLineV2(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    start: float
    end: float | None
    text: str
    status: Literal["matched", "uncertain", "failed", "unchecked"]
    source: Literal["found", "heard"]
    similarity: float | None
    heard: str | None
    aligned: bool
    pieces: list[WorkersKaraokePiece] | None
    edited: bool


class WorkersKaraokeLyricsV2(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    provider: str | None
    source: Literal["found", "heard"]
    language: str | None
    timing: Literal["line", "char"]
    check: WorkersKaraokeLyricsCheck | None
    lines: list[WorkersKaraokeLineV2]


class WorkersKaraokeReferenceV2(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    format: Literal["miyoria.karaoke.reference"]
    version: Literal[2]
    id: str
    title: str
    artist: str | None
    duration_s: float
    backing: str
    pitch: WorkersKaraokePitch
    notes: list[WorkersKaraokeNote]
    lyrics: WorkersKaraokeLyricsV2 | None
    quality: WorkersKaraokeQuality
    made: WorkersKaraokeMadeV2


class WorkersKaraokeStreamAnswer(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    hz: Literal[50]
    streams: list[WorkersKaraokeStreamFrames]
    lost: list[str] = []
    device: str
    method: str


class WorkersLyricsReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    found: bool
    result: WorkersLyricsResult | None


class Error(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    code: Literal[
        "bad_request",
        "unauthorized",
        "not_accepting",
        "not_found",
        "conflict",
        "gone",
        "too_large",
        "limit",
        "busy",
        "docker_failed",
        "unavailable",
        "internal",
    ]
    message: str
    retry_after_ms: float | None = None
    ended: Ended | None = None
    reason: str | None = None


class WorkersSandboxErrorBody(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    error: Error


class WorkersSandboxEvent7(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    seq: float
    job: str
    kind: Literal["ended"]
    reason: Literal[
        "closed", "idle", "lifetime", "lease", "disk", "lost", "shutdown", "host_policy"
    ]
    usage: WorkersSandboxJobUsage


class WorkersSandboxExecResult(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    exit_code: float | None
    killed_reason: (
        Literal["timeout", "aborted", "output_limit", "memory", "quota", "disk", "lost"]
        | None
    )
    duration_ms: float
    cpu_ms: float
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    stdout_bytes: float
    stderr_bytes: float
    files_out: list[WorkersSandboxFileOut]
    files_out_truncated: bool
    log_bytes: float


class WorkersSandboxExecStart(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    program: Program | None = None
    argv: list[str] | None = None
    stdin: str | None = None
    files: list[WorkersSandboxFileIn] | None = None
    cwd: Literal["/work", "/workspace"] | None = None
    timeout_ms: float
    env: dict[str, str] | None = None
    output: Output
    collect: Collect | None = None


class WorkersSandboxExecView(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: str
    state: Literal["running", "done", "lost"]
    started_at: float
    result: WorkersSandboxExecResult | None


class WorkersSandboxJobCreate(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    kind: Literal["run", "session", "browser", "plugin"]
    image: Literal["default", "browser"]
    for_: Literal["self", "owner", "member", "plugin"] = Field(..., alias="for")
    payer: str | None
    limits: WorkersSandboxLimits
    network: WorkersSandboxNetwork
    lifetime_s: float
    idle_s: float
    lease_s: float
    mounts: Mounts
    env: dict[str, str]
    label: str | None


class WorkersSandboxJobView(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: str
    kind: Literal["run", "session", "browser", "plugin"]
    state: Literal["starting", "ready", "busy", "ended"]
    ended: Ended | None
    image_tag: str
    limits: WorkersSandboxLimits
    created_at: float
    last_used_at: float
    expires_at: float
    usage: WorkersSandboxJobUsage
    exec: str | None
    procs: list[str]


class WorkersSingJob(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    id: str
    state: Literal["queued", "running", "done", "failed", "cancelled"]
    stage: str
    progress: float
    error: str | None
    song_id: str | None
    cached: bool
    position: float | None
    source: Source | None
    song: WorkersSingSongMeta | None
    exclusive: (
        Literal["waiting", "offloading", "active", "reloading", "done", "shared"] | None
    )
    gpu: WorkersSingGpuStatus | None
    karaoke: WorkersKaraokeSong | None = None


class WorkersSingJobReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    job: WorkersSingJob


class WorkersSingJobsReply(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    jobs: list[WorkersSingJob]


class WorkersSingLibrary(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    entries: list[WorkersSingLibraryEntry]


class WorkersKaraokeReference(
    RootModel[WorkersKaraokeReferenceV1 | WorkersKaraokeReferenceV2]
):
    root: WorkersKaraokeReferenceV1 | WorkersKaraokeReferenceV2


class WorkersSandboxEvent4(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    seq: float
    job: str
    exec: str
    kind: Literal["exit"]
    result: WorkersSandboxExecResult


class WorkersSandboxEventsPage(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    cursor: str
    events: list[
        WorkersSandboxEvent1
        | WorkersSandboxEvent2
        | WorkersSandboxEvent3
        | WorkersSandboxEvent4
        | WorkersSandboxEvent5
        | WorkersSandboxEvent6
        | WorkersSandboxEvent7
    ]
    reset: bool


class WorkersSandboxJobList(BaseModel):
    model_config = ConfigDict(
        extra="ignore",
    )
    jobs: list[WorkersSandboxJobView]
