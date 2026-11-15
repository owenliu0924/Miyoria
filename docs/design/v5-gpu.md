# GPU arbitration today: the specification hostd must reproduce

> 2026-11-16. Step H7 (a) of [v5-hostd.md](v5-hostd.md) §8 and decision P7: the song worker's GPU
> decisions, written down so that the TypeScript arbiter in hostd can be built without reading the
> Python, and recorded in two checked-in files that the arbiter must reproduce:
> `workers/sing/gpu_decisions.json` (3 172 cases of 18 decision functions) and
> `workers/sing/gpu_scenarios.json` (26 timed scenarios). `workers/tests/test_gpu_table.py`
> rebuilds both from the code on every run and fails when they differ;
> `UPDATE_GPU_TABLE=1` rewrites them. Nothing here changes behaviour.
>
> Sources: `workers/sing/gpu.py` (decisions), `exclusive.py` (offload windows), `yielding.py`
> (pausing while she speaks), `server.py` (where a job takes them), `workers/device_memory.py`,
> the `/offload`, `/reload`, `/busy`, `/health` handlers of `workers/asr/server.py` and
> `workers/tts/server.py`, `packages/sing/src/singer.ts` (Core) and
> `packages/workspace/imagegen/src/service.ts` (image generation).

## 1. Actors

| Actor | Holds on the GPU | Role today |
|---|---|---|
| TTS worker (`workers/tts`, 8002) | its model in a child process, about 4.7 GB measured | **evictable**: drops it on `/offload` (kills the child), loads again on `/reload` or when its lease runs out |
| ASR worker (`workers/asr`, 8003) | its model in a child process, about 1.5 GB | **evictable**, same protocol, no drain |
| Song worker (`workers/sing`, 8005) | per stage: the separator, the lead splitter, the voice model; the RVC pass as a subprocess (its VRAM is another process's) | the **only arbiter**: decides, asks the speech workers, renews, reloads |
| Core, `sing` module | nothing | tells the song worker who listens (`POST /gpu/context`) and says go before a window (`POST /jobs/{id}/exclusive`); pauses her speech while a window is on |
| Core, `imagegen` module | nothing; ComfyUI (8188) holds the models | holds its own jobs while a song is prepared or sung and asks ComfyUI to unload (`POST /free`): a **second channel** that does not talk to the song worker |
| OBS, VTube Studio, desktop | some GPU memory | invisible except as less free memory on the device reading |

One song job runs at a time in the worker. Everything below is per job, except three things that
are per machine (`Machine`): the device reading, the learned profile, and `gap_until` (when a
window may open again after her voice came back).

## 2. The life of one job

```
resolve → download → [separate] → [lead] → convert → [convert backing] → mix → beats → lyrics wait → video → done
                      GPU stage    GPU stage GPU stage  GPU stage
```

`separate` runs only when the stems are needed (backing `drop`/`convert`, or no lead split);
`lead` only when the lead split model exists; `convert backing` only for `backing: "convert"`
with a lead. Every GPU stage goes through `_gpu_stage`:

1. **Placement** (`_place`): loop `GpuJob.decide(stage)` (§4) every `SING_GPU_CHECK_S` (1 s)
   while it answers `wait`; the job's `stage` reads `gpu_wait` meanwhile. Then:
   `give_up` → the job fails with the reason; `offload` → open a window (§6) and run on the GPU;
   `share` → run on the GPU;
   `exclusive` (a window is already open) → run on the GPU; `cpu` → run on the CPU. On `share`,
   an `Exclusive` in state `shared` replaces the job's current one unless it is already `shared`.
   The time spent in this loop is "this wait" (`waited_s`); when the loop returns it is added to
   the job's total (`waited_total_s`).
2. **Running**: before every diffusion step or separation segment the stage calls the **gate**:
   cancel check → `torch.cuda.synchronize` → step timing → if speech is busy, **yield** (§7) →
   **tick** (§5) → act on the tick → step timing resumes. CPU stages call the gate too (they yield
   to speech as well); tick does nothing for them. A stage that never stops between steps (her RVC
   model, `SING_VOICE=rvc` or `…+rvc`) never calls the gate: it is not ticked and does not yield;
   instead a thread reads the device every 0.25 s to learn its peak.
3. **Ending**: a stage that finishes records what it measured (peak, step time, rate) and returns.
   A stage stopped by tick (`Suspended`) or by an out-of-memory error on the GPU records its peak,
   unloads every model, **closes the window if one is open** (her voice back, §6), and goes back
   to step 1, resuming where it was (conversion keeps its finished chunks; separation restarts).
4. **After the conversion**: `_give_gpu_back` stops yielding and starts the reload of the speech
   workers (asynchronous: the mix runs meanwhile). The job only counts as done (or failed, or
   cancelled) after the reload has finished: `run_job`'s `finally` waits for it, then calls
   `window_closed`, which is when `gap_until` is set.

A window opened for one stage stays open for the next ones (`separate` then `convert` in one
window, scenario `yield_demucs_separation_takes_a_window_too`); only a suspension or the end of the
job closes it.

## 3. Inputs

### 3.1 Policy

`SING_GPU_POLICY` = `yield` | `auto` | `share` | `offload` | `wait`, case-insensitive, trimmed.
Unset or invalid: the older `SING_GPU_SHARE` decides when set (`"1"` after trimming → `auto`, any
other non-empty value → `offload`); otherwise **`yield`** (the default since 2026-11-09). Read once
when the job's GPU bookkeeping starts (first GPU stage). Table: `policy_from_env`.

### 3.2 Limits (`Limits.from_env`, read at the same moment)

Integers parse with `int()`, floats with `float()`; an unparsable value (including `"1.5"` for an
integer) silently gives the default. Table: `limits_from_env`.

| Field | Variable | Default | Used for |
|---|---|---|---|
| `prior_need_mb` | `SING_SHARE_MIN_FREE_MB` | 4096 | what a stage needs until a run measured it |
| `headroom_pct` | `SING_GPU_HEADROOM_PCT` | 12.0 | share of the card kept free |
| `room_wait_s` | `SING_SHARE_WAIT_S` | 0.0 | `auto`, nobody listening: wait this long before a window |
| `defer_s` | `SING_DEFER_S` | 120.0 | `auto`: wait before a short window; `share`/`offload`: wait after a spill |
| `wait_max_s` | `SING_WAIT_MAX_S` | 600.0 | `auto`: total wait before windows regardless, or failing |
| `silence_max_s` | `SING_SILENCE_MAX_S` | 90.0 | a window's length while people listen ("reload included") |
| `silence_gap_s` | `SING_SILENCE_GAP_S` | 60.0 | her voice's time back before the next window |
| `lease_s` | `SING_OFFLOAD_LEASE_S` | 60.0 | `max_s` sent with `/offload` |
| `spill_factor` | `SING_SPILL_FACTOR` | 5.0 | steps this many times slower than normal are a spill |
| `spill_step_s` | `SING_SPILL_STEP_S` | 2.0 | the spill limit while no normal step is known |
| `steps` | `SING_DIFFUSION_STEPS` | 30 | diffusion steps |
| `steps_min` | `SING_DIFFUSION_STEPS_MIN` | 20 | steps left after a spill with nothing else to free |
| `yield_max_s` | `SING_YIELD_MAX_S` | 120.0 | total yielding for an urgent song, or with nobody listening |
| `yield_patient_s` | `SING_YIELD_PATIENT_S` | 900.0 | total yielding otherwise |
| `context_ttl_s` | `SING_CONTEXT_TTL_S` | 20.0 | Core's context is stale after this |
| `check_s` | `SING_GPU_CHECK_S` | 1.0 | the placement loop's period; how often tick reads the card |
| `burst_mb` | `SING_SPEECH_BURST_MB` | 1024 | room left for her voice next to a stage that cannot pause |

Read elsewhere in `server.py`: `SING_OFFLOAD_URLS` (comma list, `/` stripped; who is offloaded),
`SING_YIELD_URLS` (default: the offload list), `SING_EXCLUSIVE_WAIT_S` (30), `SING_RELOAD_TIMEOUT_S`
(300), `SING_YIELD_POLL_MS` (100), `SING_YIELD_HOLD_MS` (300), `SING_CPU_FALLBACK` (comma list of
stages, read once at import; when unset, a real backend whose separator is a Demucs model adds
`separate`; with the default Mel-Band RoFormer separator it stays empty).

### 3.3 Measured and learned (`gather` builds the `Facts`; table `gather`)

| Fact | How it is obtained |
|---|---|
| `cuda` | the backend uses CUDA (`SING_DEVICE`); false → everything on the CPU |
| `on_gpu` | the stage is configured for the GPU (`SING_SEPARATE_DEVICE`, `SING_LEAD_DEVICE` can say `cpu`) |
| `pauses` | false only for the conversion when the voice chain has an RVC pass |
| `total_mb`, `free_mb` | the **whole device** through NVML (`device_memory.read`): other processes included. No NVML on Linux: `torch.cuda.mem_get_info`; on Windows without NVML: unknown (`None`). A read that raises: CUDA with everything unknown |
| `own_mb` | `torch.cuda.memory_reserved` of the song worker: counted as room (`room = free + own`) |
| `need_mb` | `typical_peak` of the stage's last 5 measured peaks, else `prior_need_mb` |
| `headroom_mb` | `max(round(total × headroom_pct / 100), learned)`; Python `round` is half-to-even (table `headroom`) |
| `freed_mb` | learned: free VRAM gained across the last window opening; else the sum of `released_mb` the speech workers report in `/health`; else unknown |
| `speech_loaded` | any offload URL whose `/health` says `offloaded: false`, or does not answer (counts as loaded); read at most every 2 s (timeout 0.5 s), re-read after a window opens or closes (table `speech.read`) |
| `people` | §3.4 |
| `urgent` | §3.4 |
| `waited_s` | this placement loop so far; `waited_total_s` adds the earlier ones of this job |
| `silence_est_s` | `audio_s × (1 − converted) × rate(convert)` (+ `audio_s × rate(stage)` for `separate`/`lead`) `+ reload_s`; rates learned (priors 0.05 / 0.25 / 0.3 s per audio s; a learned 0 counts as unknown), `reload_s` learned (prior 30). No audio length → unknown (table `silence_estimate`) |
| `gap_s` | `max(0, gap_until − now)` |
| `window` | a window is open for this job |
| `offload_useless` | a window was tried and the stage still spilled or ran out of memory in it |
| `cpu_only` | separation or lead spilled once: such stages go to the CPU for the rest of the job |
| `cpu_fallback` | the stage is in `CPU_FALLBACK` |
| `crowded_mb` | room (`free + own`) at the last spill or out-of-memory |

The learned profile is per card (`name/total_mb`) in `<SING_DATA_DIR>/_gpu-profile.json`:
per stage the last five peaks, the normal step time (a clean run's median; it sinks at once and
rises at most 20 % per run), samples and rate; per card the learned headroom (raised by a spill to
`min(free_at_spill + 256, total // 4)`, lowered by a clean run whose lowest free was below it),
`freed_mb`, `reload_s`, the last ten spills. Tables `typical_peak`, `profile.note_step`,
`profile.note_spill`, `profile.note_healthy`.

### 3.4 Audience and urgency (from Core)

Core's `sing` module, on every poll (`poll_ms`, 1500 ms) **while at least one song is preparing**,
sends `POST /gpu/context {in_voice, listeners, live, urgent: [job ids]}`:
`in_voice` = she is in any voice channel; `listeners` = people in those channels; `live` = Go Live
or streaming; `urgent` = jobs of songs that are **forced** (asked by command or the queue: sung as
soon as ready). The worker stores it with the time.

`people` (table `audience.people`):
- never told: `None` (unknown) when the job was submitted with `exclusive_ack` (Core will speak),
  else `False`;
- told longer than `context_ttl_s` ago (strictly more): `None`;
- else `live or (in_voice and listeners > 0)`.

`None` counts as people everywhere it matters: it never lets a job take her voice for want of
listeners, and an open window keeps its limit. `urgent` (table `server.urgent`): this job's id is in
the list, or the id of a job still **queued** behind it.

## 4. Placement: `decide(Facts)` in the order the code tests

`want = need + headroom + burst`, where `burst = burst_mb` only when the stage does not pause and
speech is loaded. `room = free + own` (unknown when `free` is). `fits` = room known, `room ≥ want`,
and, after a spill or OOM, `room ≥ crowded + 0.1 × need`. `separate` = the stage is `separate` or
`lead`. `can` = `speech_loaded and not offload_useless`.

| # | Condition | Outcome (`mode/code`) |
|---|---|---|
| 1 | not `cuda` | `cpu/no_cuda` |
| 2 | not `on_gpu` | `cpu/configured_cpu` |
| 3 | `window` | `exclusive/window` |
| 4 | `cpu_only` | `cpu/spill_cpu` |
| 5 | policy `share`: `crowded` set and `waited_s < defer_s` | `wait/share_spill`, else `share/policy_share` |
| 6 | policy `offload`: not `speech_loaded` | `share/nothing_to_offload` |
| 6b | … `offload_useless and not fits and waited_s < defer_s` | `wait/offload_useless`, else `offload/policy_offload` |
| 7 | `fits` | `share/fits` |
| 8 | policy `wait` | `cpu/policy_wait_cpu` for `separate`/`lead`, else `wait/policy_wait` |
| 9 | room unknown and not `speech_loaded` | `share/unknown_card` |
| 10 | policy `yield`: `cpu_fallback and (not can or gap_s > 0)` | `cpu/no_room_cpu` |
| 10b | … `gap_s > 0 and can` | `wait/gap` |
| 10c | … `can` | `offload/urgent` when urgent, else `offload/no_room` |
| 10d | … otherwise | `wait/no_room` (no time limit: never `give_up`) |
| 11 | `auto` from here. `helps` = `can` and (freed unknown or room unknown or `room + freed ≥ want`); `small` = `total < want` | |
| 12 | `people is False and helps and waited_s ≥ room_wait_s` | `offload/nobody_listening` |
| 13 | `separate` and (not urgent or not `can` or `gap_s > 0`) | `cpu/no_room_cpu` |
| 14 | `gap_s > 0 and can` | `wait/gap` |
| 15 | `urgent and can` | `offload/urgent` |
| 16 | `helps` and `silence_est_s ≤ silence_max_s` (known) and `waited_s ≥ defer_s` | `offload/short_silence` |
| 17 | `waited_total_s ≥ wait_max_s`: `can` | `offload/waited_long` |
| 17b | … not `can` and not `small` | `give_up/no_room` |
| 18 | `small and not can` | `share/too_small` |
| 19 | otherwise | `wait/no_room` |

Every outcome also carries a Chinese `reason` that she may say; the table records it verbatim
(numbers formatted with Python's `{:.0f}` and `{:.1f}`, GB as MB/1024). The job's decision history
keeps a new entry only when `mode/code` changes.

## 5. While a stage runs: `tick` (once per step, GPU stages only; table `tick`)

1. **Card reading**: at most every `check_s`; otherwise the last reading. A known reading below
   `headroom / 2` counts a low read (`low_reads + 1`), a known one at or above resets it, an
   unknown one leaves it.
2. **Silence limit** (only with a window open and policy not `offload`): if `people is False`, the
   silence clock is cleared; otherwise it starts now if not running. `work_s = max(silence_max_s −
   reload_s, silence_max_s / 2)` (with the defaults: 60 s, or 45 s once a reload took ≥ 45 s). When
   the clock has run `≥ work_s`: **suspend** `silence_limit`.
3. **Spill test**: `slow` = the last three step times all `≥ limit`, `limit = normal × spill_factor`,
   or `spill_step_s` when no normal step is known. A slow run with no normal step and free unknown
   or `free > headroom` is not a spill (a slow card). `low` = `low_reads ≥ 3` and no window and
   `people is not False`. Neither → nothing (and `spilling` false).
4. **Response**, in order:
   - first time in this stage run: **trim** (`spill_free`): free the worker's cache, count a spill,
     learn the headroom if it was a slow-step spill, clear the step window and low reads;
   - then (window cleared, low reads cleared): a `separate`/`lead` stage → `cpu_only`, **suspend**
     `spill_cpu` (redone on the CPU);
   - with a window open: conversion not yet reduced and `steps_min < steps` → **reduce** to
     `steps_min` (`spill_reduce`, the remaining chunks use fewer steps); else `offload_useless`,
     `crowded = room`, **suspend** `spill_wait`;
   - policy `share`, conversion not yet reduced → **reduce**;
   - policy `auto`/`yield`, speech loaded, not useless, no gap, and (urgent or `people is False`)
     → **offload** `spill_offload` (a window opens between two steps; the stage keeps its memory
     during Core's go and the offload);
   - else `crowded = room`, **suspend** `spill_wait`.

A suspension unloads the stage, closes any window, and returns to placement (§2).

## 6. Windows, leases and recovery (`exclusive.py`)

One `Exclusive` per window. States: `None → waiting → offloading → active → reloading → done`, or
`None → shared` (sharing; nothing offloaded). Core treats `offloading`, `active` and `reloading`
as "speech is off" and pauses her speech.

- **Opening** (`_open_window`): `job.go` is cleared (every window waits for its own go); the job's
  `stage` reads `exclusive`. With `exclusive_ack` (Core sets it when `prepare_notice` is on, the
  default): state `waiting` until Core's `POST /jobs/{id}/exclusive` or `SING_EXCLUSIVE_WAIT_S`
  (30 s), polling every 0.1 s, cancel checked. Then `offloading`: `POST <url>/offload {"reason":
  "sing", "max_s": lease_s}` to each URL **in turn** (timeout 60 s). Any reply without an exception
  counts as offloaded; a failure is logged in `errors` and skipped. Then `active`; `window_opened`
  starts the silence clock (unless `people is False`) and learns `freed_mb` from the change of free
  VRAM since just before the offload (only when positive).
- **Renewal**: while active, a thread re-sends the same `/offload` to every URL that was **asked**
  (also those that failed: they may answer now) every `max_s / 3` (20 s), timeout `min(5, max_s/3)`.
  The speech worker treats each one as a fresh lease of `max_s`. With `lease_s = 0` there is no
  renewal and the workers never come back by themselves.
- **Closing** (`end`, idempotent): renewals stop; state `reloading`; a thread sends `POST
  <url>/reload {}` to every asked URL **in turn** (timeout `SING_RELOAD_TIMEOUT_S`, 300 s); failures
  are logged (the lease, no longer renewed, brings that worker back by itself); then `done`.
  `_close_window` waits for the reload, then `window_closed`: the silence clock stops; **if it was
  running** (people could hear), `gap_until = now + silence_gap_s`; `reload_s` is learned from the
  reload's duration.
- **Holder dies**: nobody renews; each speech worker reloads by itself `max_s` after the last
  renewal (60 s by default, 40 to 60 s after the death). Scenario
  `holder_dies_mid_window_restart_after_lease`.
- **Startup recovery** (`_recover_speech`, a thread at the worker's start): for each offload URL,
  `GET /health` (2 s); if `offloaded` and `reason == "sing"` exactly, `POST /reload` (300 s).
  Errors are logged. Table `server.recover_speech`; scenario
  `holder_dies_mid_window_restart_before_lease`.

## 7. Yielding while she speaks (`yielding.py`)

Created with the job's GPU bookkeeping: polls `GET <url>/busy` (timeout 0.5 s) for each
`SING_YIELD_URLS` URL every `poll_s` (0.1 s), once at start. Any `busy > 0` sets
`busy_until = now + hold_s`, `hold_s = max(SING_YIELD_HOLD_MS / 1000, 2 × poll_s)` (0.3 s; table
`yield.hold`). A worker that does not answer counts as idle. In the gate: if busy, the allowance is
set to `yield_allowance()` (`yield_max_s` when urgent or `people is False`, else `yield_patient_s`;
table `yield_allowance`), then the job sleeps in 20 ms steps while busy, until the allowance used
by this job in total reaches it ("going on regardless"). Time spent yielding is not step time.
Polling stops at `_give_gpu_back`. Scenarios `yield_patience_*`, `share_24gb_people_she_speaks_mid_song`.

## 8. The speech workers' side (peer protocol)

Both workers keep their model in a child process; to offload is to kill it, which returns all its
VRAM. All routes take a bearer token when hostd set one (`service_auth`).

| Request | Reply (200 unless noted) |
|---|---|
| `POST /offload {reason?: string, max_s?: number, drain_s?: number}` (TTS reads `drain_s`; unknown fields ignored; a body of the wrong type → 400 `{"error": "invalid request: …"}`) | fresh: `{"state": "offloaded", "offload_ms", "vram_before_mb", "vram_after_mb", "device_used_before_mb", "device_used_after_mb", "released_mb"}` (TTS adds `"drained": bool`); already offloaded: `{"state": "offloaded", "offload_ms": 0, "already": true, "since", "reason", "reload_at"}`; during a reload in a child: the child is killed, `{"state": "offloaded", "offload_ms": 0, "cancelled_reload": true, …device fields}`; during a reload in-process (`*_ENGINE_PROCESS=0`): `{"state": "reloading", "offload_ms": 0}` and **no lease is set** |
| `POST /reload` | loaded: `{"state": "ready", "reload_ms": 0, "already": true}`; else waits for the load (one load shared by concurrent calls; the auto-reload timer is cancelled): `{"state": "ready", "reload_ms", "vram_mb", "device_total_mb", "device_used_mb", "device_free_mb"}`, or `{"state": "offloaded", "cancelled": true}` when an offload stopped it |
| `GET /busy` | `{"busy": n}`: ASR `/asr` requests under way (from upload to answer); TTS utterances being synthesized |
| `GET /health` | `{"status": "ok", "offloaded": bool, "loading": bool, "released_mb": int|null, …}`; while offloaded also `since`, `reason`, `reload_at`; device fields when NVML works |

On their own:
- **Lease**: every `/offload` (fresh or not) restarts a timer of `max_s` (default
  `ASR_OFFLOAD_MAX_S` / `TTS_OFFLOAD_MAX_S` = 900 when the request names none; `0` = never). When
  it fires, the worker reloads itself. `/reload` cancels it.
- **Drain** (TTS only): new `/tts` calls get 503 `{"error": "offloaded"}` at once; utterances under
  way get `drain_s` (`TTS_OFFLOAD_DRAIN_S`, 15 s; the song worker sends none) to finish, then stop
  at their next chunk. ASR answers 503 to new requests and waits only for the running one.
- **Crash** (TTS): a child that died by itself is restarted, with `reason: "engine crashed"`.
- `released_mb` is measured on the device after the memory settles (`device_memory.settled`: reads
  every 0.1 s until used memory stops falling by more than 32 MB for 0.5 s, at most 3 s).

## 9. What Core contributes, and image generation

- **Context**: §3.4. Pushed only while a song is preparing, every 1.5 s; the worker's TTL is 20 s.
- **Go** (`packages/sing/src/singer.ts`): when a job's `exclusive` is `waiting`, she announces
  that she is off to prepare the song (unless she is not in voice: go at once; or she announced
  within `prepare_notice_gap_secs`, 180 s: go as soon as she is not speaking). Go is sent when she
  spoke and was quiet for `quiet_ms` (700 ms), or did not start within 8 s, or after
  `announce_max_secs` (20 s). Speech is paused from `offloading` until the window is over.
- **Image generation** (`ImageGenService`, `pause_while_singing` and `free_on_sing`, both on by
  default): while a song is **being prepared** (any stage, CPU or download included: Core's
  `SingPrepare` event has a song) or **sung**, no image job starts and a running **batch** job is
  interrupted and requeued; when that period starts, ComfyUI is asked to unload
  (`POST /free {"unload_models": true, "free_memory": true}`). ComfyUI is also unloaded after
  `free_after_idle_s` (120 s) without work. The song worker knows nothing of this: ComfyUI's memory
  is simply missing from the device reading.

## 10. Oddities and doc/code mismatches (not fixed)

1. `server.py`'s docstring lists `SING_GPU_POLICY auto | share | offload | wait (default auto)`.
   The code's default is `yield`, and `yield` is missing from the list.
2. `gpu.py`'s docstring says that under `yield` "only Demucs' separation (`CPU_FALLBACK`) goes to
   the CPU instead" of taking her voice. The code sends a `CPU_FALLBACK` stage to the CPU only
   when speech cannot help (`not can`) or during a gap; otherwise it takes a window like any stage.
3. Under `yield` there is no time limit and no `give_up`: a job whose window did not help
   (`offload_useless`) waits for room for ever (scenario
   `yield_spill_inside_a_window_waits_for_ever`). `yield` also ignores `freed_mb` (`helps`),
   `people`, `defer_s`, `room_wait_s` and the silence estimate for opening a window.
4. **Suspected bug**: after the conversion, `_give_gpu_back` starts the reload, but the job's
   `window` flag stays set until the job ends. A `backing: "convert"` pass after a window is
   therefore placed `exclusive/window` and runs on the GPU while TTS and ASR are reloading, with
   yielding already stopped. (Not in the scenarios: the simulated pipeline has no backing pass.)
5. Three different "how long to wait for go": `Exclusive`'s own default `ack_wait_s` 20 s, the
   server's `SING_EXCLUSIVE_WAIT_S` default 30 s (the one in effect), and Core's
   `announce_max_secs` 20 s plus up to 8 s before she starts.
6. The silence clock of a window starts when the offload has finished (`window_opened`), but Core
   pauses her speech from `offloading` on; the ack wait and the offload (seconds; TTS may drain
   15 s) are not counted, and the reload is counted only by its learned estimate. With a reload
   of 87 s (11-07) the real silence is about 45 + 87 s, not "90 s, reload included".
7. `silenced_s` and the gap run from `window_opened` to `window_closed`, and for the last window
   `window_closed` is called only at the end of the job (after mix, beats, lyrics and video), so
   the next job's gap starts late.
8. Under policy `offload` a window has no silence limit at all, whoever listens.
9. `Exclusive` counts any reply of `/offload` as offloaded, including `{"state": "reloading"}`
   from a worker with an in-process engine, which did not offload and set no lease.
10. A speech worker that does not answer `/health` counts as **loaded** (so the job may still try
    to offload it), but one that does not answer `/busy` counts as **idle**.
11. `SING_GPU_SHARE` other than `"1"` (`true`, `yes`) means `offload`. An integer limit written as
    `1.5` silently falls back to its default.
12. A job submitted without `exclusive_ack` and before any context counts as "nobody listening"
    (`people` false), so under `auto` it may take her voice at once.
13. `waited_s` (for `defer_s`, `room_wait_s`, `share`'s spill wait) is the current placement loop
    only; `wait_max_s` uses the job's total. A suspension restarts the former.
14. `share` after a spill waits `defer_s` and then shares again, even though nothing changed
    (scenario `share_policy_spill_reduces_then_waits`).
15. The decision history drops a decision whose `mode/code` equals the previous one, so a changed
    reason (people turning unknown during `wait/no_room`) is not recorded.
16. `round()` in the headroom is half-to-even; JavaScript's `Math.round` is half-up. The table
    has such cases (`headroom`, `headroom_pct` 12.5).
17. The RVC warm-up process (`rvcpass`) can hold VRAM outside any stage (it is kept between
    queued jobs); stages wait for it (`wait_warm`) but it counts only as "less free memory".
18. `/health`'s `gpu.policy` is read from the environment at each request, while a job keeps the
    policy it started with.

## 11. The recorded table and scenarios

`gpu_decisions.json`: a `header` (defaults of every limit and the variable behind it, constants,
the base input per function, case counts) and one case per line `{"fn", "in", "out"}`. For
`decide`, `gather` and `tick` the input is `header.bases[fn]` with `in` laid over it; a `limits`
object is a change of `header.limits_default`. Grids are generated, placed just below, at and above
each threshold, and every outcome code of `decide` and `tick` occurs.

| Function | Cases | What varies |
|---|---|---|
| `decide` | 1733 | early exits × policy; fit boundary (want ± 1, own memory, crowded ± 0.4 MB, burst); `auto` people × urgent × speech × useless × gap × freed; waits around `defer_s`/`wait_max_s` × silence estimate around 90 s × small card; `room_wait_s`; `yield`; `share`/`offload`/`wait` |
| `tick` | 673 | spill detection (normal known or not, step window below/at/above the limit, free none/plenty/= headroom/< headroom/2, low reads); responses per stage × policy × window × reduced × speech × useless × gap × urgent/people; the silence limit around 45 s and 60 s |
| `gather` | 53 | card (none, unreadable, raising, 12 GB, own memory), profile fresh or learned, speech loaded/offloaded/one down, `cpu_only`, `CPU_FALLBACK`, wait and gap state |
| `headroom` | 108 | total × percent × learned, half-to-even cases |
| `typical_peak` | 125 | multisets of 1 to 5 peaks around twice the median |
| `audience.people` | 98 | age none / 0 / 19.9 / 20 / 20.1 × flags × `core_expected` |
| `limits_from_env` | 85 | each variable unset, valid, padded, fractional/exponent, invalid |
| `silence_estimate` | 72 | audio length × converted share × stage × learned rates |
| `policy_from_env` | 45 | both variables |
| `speech.read`, `speech.read_cache` | 43, 8 | per-worker replies, the 2 s cache |
| `server.recover_speech` | 34 | each worker's `/health` × reload failing |
| `profile.note_step/spill/healthy` | 21, 30, 12 | learning arithmetic |
| `server.urgent`, `yield_allowance`, `yield.hold` | 15, 12, 5 | |

`gpu_scenarios.json`: 26 scenarios. The real `server.py` job loop (`run_job`, `_gpu_stage`,
`_place`, the gate), `GpuJob`, `Exclusive` and `SpeechYield` run their own threads on a simulated
clock, one at a time; the device, the speech workers (a model of §8 with made-up timings: TTS
4700 MB, offload 3 s, reload 20 s; ASR 1500 MB, 1 s, 8 s), Core (context every 1.5 s, go 4 s after
`waiting`) and the stages (fixed step times) are fakes. Each scenario has its `setup`, the
`result` (job outcome, the job's GPU summary, the last `Exclusive`, yielding, speech worker
states, what was learned) and `events`: state changes (`stage`, `exclusive`, `window`, `running`,
`yield_pauses`, each speech worker), every POST with body and reply, every recorded decision with
its reason, and the script's own events. Scenarios: sharing on 24 GB while she speaks; `yield`
windows with go, without go (30 s), long song with bounded windows and gaps, alone then someone
joins, Demucs separation; `auto` waiting then a short window, waiting the maximum, urgent, Core
going quiet mid-wait, Core gone with a window open; a speech worker unreachable; the holder dying
(restart after and before the lease); spills while sharing, in separation, inside a window under
`auto` (fails) and under `yield` (waits for ever); out of memory then a window; yield patience
urgent and not; policies `share`, `wait`, `offload`; no CUDA; the RVC stage and her voice's burst.

**Not covered** by either file, and why:
- `device_memory` (NVML through ctypes), `settled`, `report`, the torch readings
  (`memory_reserved`, peak stats, `synchronize`): they need the device; described in §3.3 and §8.
- The engine's own out-of-memory fallback inside `RealBackend.separate` and `split_lead` (an OOM
  there retries on the CPU without asking `gpu.py`), and the Seed-VC/RVC internals.
- `GpuJob.finished` / `stopped` gating of what is learned (clean run, tight first run, resumed
  run): only the arithmetic is tabled; the scenarios show its effect on `learned`.
- The speech workers' real code (asyncio servers): modelled in the scenarios;
  `tests/test_asr_offload.py` covers the ASR lease and self-reload. TTS drain is not exercised.
- HTTP timeouts (offload 60 s, renewal 5 s, reload 300 s, `/health` 0.5 s and 2 s, `/busy` 0.5 s):
  the fakes answer or refuse at once.
- Core's announcement logic (modelled as "go 4 s after waiting") and image generation (§9; no
  Python involved).
- Cancellation paths (the cancel checks in the placement loop, the ack wait and the gate).
- The `backing: "convert"` pass (see oddity 4).

## 12. Mapping to hostd

The design (v5-hostd §8) gives hostd a lease table: `gpu.acquire { mb, mode, max_s, reason }` →
`granted` (with what was evicted) / `wait` (with the reason) / `cpu`; `gpu.renew`; `gpu.release`;
`gpu.busy`; `gpu.state`; Core sends `cluster.context { in_voice, listeners, live, urgent }`.

### 12.1 Decisions (must match the table)

| Today | In hostd |
|---|---|
| `decide` (all of §4) | the evaluation of a `gpu.acquire`: `share` → `granted` without eviction; `offload` → `granted` with eviction of the evictable tenants; `exclusive` → the holder already has an exclusive lease (renew, not acquire); `wait` → `wait` with `code` and `reason`; `cpu` → `cpu`; `give_up` → no outcome exists yet (Q3) |
| `gather` | hostd's own reading and state, plus fields only the client knows (Q1) |
| `policy_from_env`, `limits_from_env` | per host settings (`host.toml [gpu]`), same names and defaults |
| `headroom`, learned `freed_mb` and `reload_s`, `gap_until` | per card: hostd's state |
| `audience.people`, `context_ttl_s` | `cluster.context` with the same freshness rule; never told = unknown |
| `server.urgent` | `urgent` ids in `cluster.context` matched against the acquiring job (Q1) |
| `tick` step 2, the silence limit | hostd owns the window clock; it ends a window by answering a `gpu.renew` with "release" (Q4) |
| `tick` steps 1, 3, 4, spill detection | stays in the client (only it sees step times); it reports the outcome (Q5) |
| `yield_allowance`, `yield.hold` | Q6 |
| `server.recover_speech` | replaced: hostd reloads what it evicted when a lease ends, expires, or its holder exits |
| `typical_peak`, `profile.note_step`, `silence_estimate` | stay in the client (per stage, per song) and travel in `gpu.acquire` (Q1) |

### 12.2 Mechanism (moves from the song worker to hostd)

The device reading (NVML), `GET /health` of the speech workers, `POST /offload` with renewals every
`max_s / 3`, `POST /reload` (in turn, waiting for it before the next decision), the gap, the
`/busy` polling, and the startup recovery. The song worker keeps: the stage loop, the gate, the
spill detection, the reduction of diffusion steps, its own trim/unload, and its job state fields
(`exclusive`, `gpu`) that Core reads.

### 12.3 Open questions (each with a recommendation; nothing decided here)

**Q1. What does `gpu.acquire` carry?** The table's inputs that only the client knows are `stage`,
`pauses`, `need_mb` (learned peak, or the prior), `on_gpu`, `cpu_fallback`/"can run on the CPU",
`silence_est_s`, the job's spill history (`cpu_only`, `offload_useless`, `crowded_mb`), and which
job it is (for `urgent` and for the waits).
*Recommendation*: `gpu.acquire { job, stage, mb, pauses, cpu_ok, est_s, crowded_mb?,
offload_useless?, max_s, reason }`; hostd keeps per `job` the start of the current wait and the
total (so `waited_s`/`waited_total_s` mean what they mean today: the client re-asks every
`check_s` while told `wait`, and a `granted`/`cpu` answer ends "this wait"). `mode` then becomes
an upper bound: `share` never evicts (image generation), `exclusive`/default may.

**Q2. Core's go before an eviction.** Today the decision is taken, the job shows `waiting`, Core
announces, Core says go to the worker, and only then are the workers offloaded.
*Recommendation*: keep the handshake where Core already watches it: hostd answers
`wait { code: "announce", evict: [...] }` for a decision `offload` when the job asked with
`ack: true`; the worker shows `exclusive: "waiting"`, waits for Core's go (or
`SING_EXCLUSIVE_WAIT_S`) as now, and acquires again with `announced: true`, which hostd grants with
the eviction without deciding again. Alternative: Core says go to hostd over the link; cleaner,
but Core's speech pause would then have to follow hostd's state instead of the job's.

**Q3. `give_up`.** The lease model has no "never".
*Recommendation*: a fourth answer `refused { code, reason }` (the job fails with the reason), so
the table maps one to one.

**Q4. Ending a window.** Today the job itself ends a window at its silence limit (between two
steps) and closes it after the conversion.
*Recommendation*: hostd runs the silence clock (it knows when eviction finished and has the
context) and answers the holder's next `gpu.renew` with `{ release: "silence_limit" }`; the client
suspends at its next step and calls `gpu.release`; hostd reloads, waits for the reload, then sets
the gap. To keep the table's timing, the client must renew at least every `check_s` while a
window is open (today the check happens before every step), i.e. renewal becomes a per-step
`gpu.renew` at most once per `check_s`, not only `max_s / 3`.

**Q5. Spills.** Detection needs step times, so it stays in the client; the response depends on
policy, people, urgency, gap and speech state, which hostd has.
*Recommendation*: the client reports `gpu.renew { spill: { slow|low, free_mb, step_s,
baseline_s } }` and hostd answers with the action (`trim`, `reduce`, `release` with `spill_wait`
or `spill_cpu`, or `evict` for `spill_offload`) using the `tick` rows of the table; hostd learns
the headroom from it. The simpler alternative (client decides as today and only releases) would
leave part of the arbitration in Python, against P7.

**Q6. Yielding.** Pausing between steps can only happen in the client.
*Recommendation*: `gpu.busy` answers `{ busy: bool, allowance_s }` from hostd's cache of the
evictable tenants' `/busy` (polled every 100 ms only while a sharing lease is held, hold 300 ms),
with `allowance_s` from the context (`yield_allowance`); the client keeps the 20 ms pause loop and
its running total.

**Q7. Who renews the speech workers' own lease, and with what `max_s`?** Today `max_s` = 60 s,
renewed by the song worker; the speech workers' self-reload is the safety net when it dies.
*Recommendation*: hostd sends `/offload { max_s: 60 }` and renews every 20 s while the holder's
lease is alive; the self-reload stays as the net for hostd itself dying. hostd's own lease on the
client can be longer, since it also sees the process exit.

**Q8. Budget and `reserve_mb`.** The table's decisions use the **measured** free memory of the
device (what OBS and VTube Studio use is already missing from it) plus a percentage headroom.
§8 of v5-hostd says "budget: total minus `reserve_mb`".
*Recommendation*: decisions use the measured reading exactly as today (otherwise the table cannot
match); `reserve_mb` only for the static check of what fits on a machine (installer, `doctor`)
and for a card that cannot be read.

**Q9. Image generation.** Today it is a separate, coarse rule in Core (hold all jobs and unload
ComfyUI while a song is prepared or sung).
*Recommendation*: ComfyUI as an `on_demand` tenant that acquires with `mode: "share"` (never
evicts speech, as today); hostd answers it `wait` while a song job has a lease or a pending
acquire, and posts `/free` to it when its lease ends or a song job needs the room. "Hold while she
**sings**" (playback, no GPU decision) stays in Core. Keep `free_after_idle_s` as a linger after
the lease rather than freeing at once, so a burst of image jobs does not reload each time. This
changes when ComfyUI is unloaded (on demand rather than on every song), so it is a behaviour
change to agree on; it is outside the table.

**Q10. The stage's prior need.** Today `SING_SHARE_MIN_FREE_MB` (4096) until a stage was measured.
The descriptor has `vram_mb.peak`.
*Recommendation*: the client keeps learning per stage and sends `mb`; the descriptor's peak is
only the prior and must be 4096 for `sing` to match the table.

**Q11. The oddities.** Some of §10 are probably not intended (2, 3, 4, 6, 9).
*Recommendation*: reproduce them as recorded first (the table is the contract), and fix each one
afterwards as its own change to both the table and the arbiter, with the owner's word, rather
than mixing fixes into the port.

**Q12. Core's speech pause.** Core pauses her speech when the sing job's `exclusive` state is
`offloading`, `active` or `reloading`. Once hostd evicts, Core could learn it from hostd's
`host.report` instead.
*Recommendation*: keep the job field for H7 (the client mirrors its lease into `exclusive`), and
move to hostd's report only when a second tenant can evict speech.
