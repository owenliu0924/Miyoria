// `/her`: a logged-in member alone with her (docs/design/her-room.md, the approved mock
// docs/design/mock/her-room.html). She fills the stage; her current line streams in above one long
// capsule, the member's last line faint above it; the backlog and her words about them open over
// the stage. Everything here goes through `RoomApi` (room-api.ts).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MemberSession } from "@miyoria/contracts/api";
import { useConnection } from "@/app/connection";
import { isApiError } from "@/api/http";
import { Logo } from "@/components/logo";
import { SITE_NAME } from "@/lib/site-name";
import { LIVE_PAGE } from "../live/path";
import { type Attached, admit, kindOfFile, readyToSend, tooBig } from "./attach-limits";
import { Attachments, DropHint } from "./Attachments";
import { Backdrop } from "./Backdrop";
import { Backlog } from "./Backlog";
import { BondMark } from "./BondMark";
import { Capsule } from "./Capsule";
import type { RoomFile, RoomMemory } from "@miyoria/contracts/api";
import { Figure } from "./FigureView";
import { type HerFigure, poseFor } from "./figure";
import { faceFor } from "./live2d";
import { SwipeTracker, WheelUp } from "./gestures";
import { type HerContent, HerAnnouncer, HerLine, useReveal } from "./HerLine";
import { Relation } from "./Relation";
import { type RoomApi, roomApiFor } from "./room-api";
import { hasMore, isAnswering, lastHerLine, shownLine } from "./room-store";
import { askAbout, capsuleHint, problemOf } from "./room-text";
import { StatusLine } from "./StatusLine";
import { newClientId, useRoom } from "./use-room";
import { RoomVoice, voiceKey } from "./voice";
import "./room.css";

/** After her reply, the member's line stays this long before it fades, ms (longer under reduced motion). */
export const YOU_FADE_MS = 4_000;
export const YOU_FADE_REDUCED_MS = 8_000;
/** Without any reply, it fades after this long. */
export const YOU_WAIT_MS = 20_000;

function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  return useSyncExternalStore(
    (on) => {
      const m = window.matchMedia?.(query);
      m?.addEventListener?.("change", on);
      return () => m?.removeEventListener?.("change", on);
    },
    () => window.matchMedia?.(query).matches === true,
    () => false,
  );
}

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Top({ member, home }: { member: MemberSession | null; home: string }) {
  return (
    <header className="hr-top">
      <a className="hr-back" href={home} aria-label="我的頁面">
        <ArrowLeft className="hr-i" aria-hidden="true" />
        <span className="hr-label">我的頁面</span>
      </a>
      <span className="hr-sep" aria-hidden="true" />
      <span className="hr-brand">
        <Logo className="text-foreground" />
        {SITE_NAME}
      </span>
      {member && (
        <span className="hr-me">
          {member.avatar_url ? (
            <img className="hr-avatar" src={member.avatar_url} alt="" />
          ) : (
            <span className="hr-avatar" aria-hidden="true">
              {[...member.name][0] ?? ""}
            </span>
          )}
          <span className="hr-name">{member.name}</span>
        </span>
      )}
    </header>
  );
}

export interface RoomProps {
  api: RoomApi;
  member: MemberSession | null;
  home: string;
  /** Her figure (Live2D when the Core serves it, else the loops; a stand-in in tests). */
  figure?: () => HerFigure;
  /** This tab's id for the voice's choice of tab. */
  tab?: string;
}

/** The room itself, given its API. */
export function Room({ api, member, home, figure, tab }: RoomProps) {
  const { model, dispatch, unavailable, send, loadOlder, exclude } = useRoom(api);
  const queryClient = useQueryClient();
  const reduced = useReducedMotion();
  const state = model.state;
  const open = state?.open === true && unavailable === null;

  const relation = useQuery({
    queryKey: ["room", "relation"],
    queryFn: ({ signal }) => api.relation(signal),
    enabled: open,
    staleTime: 60_000,
  });

  // ---- her voice ------------------------------------------------------------------------------
  const tabId = useMemo(() => tab ?? newClientId(), [tab]);
  const voice = useMemo(() => new RoomVoice({ fetch: (line, signal) => api.voice(line, signal), tab: tabId, problem: problemOf }), [api, tabId]);
  useEffect(() => {
    voice.connect();
    return () => voice.dispose();
  }, [voice]);
  const voiceSnap = useSyncExternalStore(voice.subscribe, () => voice.snapshot, () => voice.snapshot);
  useEffect(() => {
    voice.setAvailable(state?.voice.available === true);
  }, [voice, state?.voice.available]);
  const voiceLevel = useCallback(() => voice.level(), [voice]);

  // ---- her line on the stage ------------------------------------------------------------------
  const turn = model.turn;
  const live = shownLine(turn);
  const resting = live === null && !isAnswering(turn) ? lastHerLine(model.entries) : null;
  const line = live ?? resting;
  const content: HerContent = (() => {
    if (unavailable === "missing") return { kind: "closed", text: "她的房間現在沒有開" };
    if (unavailable === "logged_out") return { kind: "closed", text: "登入已經失效,重新整理後再登入一次" };
    if (state && !state.open) return { kind: "closed", text: state.closed ?? "她的房間現在沒有對你開放" };
    if (turn && turn.phase === "thinking" && live === null) return { kind: "thinking", step: turn.step };
    if (line) return { kind: "line", id: line.id, text: line.text, files: line.files };
    return null;
  })();
  const lineText = content?.kind === "line" ? content.text : "";
  const reveal = useReveal(content?.kind === "line" ? content.id : null, lineText, reduced || live === null);
  const more = hasMore(turn) && live !== null;

  const advance = useCallback(() => {
    if (content?.kind === "line" && !reveal.done) {
      reveal.finish();
      return;
    }
    dispatch({ type: "advance" });
  }, [content?.kind, reveal, dispatch]);

  // A new step of hers on the stage is read out when the Core offers it.
  useEffect(() => {
    if (live) void voice.play(live);
  }, [live, voice]);
  // A reply that moved on (a new turn) stops the old line.
  useEffect(() => {
    if (!live) voice.stop();
  }, [live, voice]);

  const announced = (() => {
    if (content === null) return "";
    if (content.kind === "thinking") return content.step ? `她在${content.step}` : "她在想";
    if (content.kind === "closed") return content.text;
    return live ? `她說:${content.text}` : "";
  })();

  // ---- the member's line, faint above hers --------------------------------------------------
  const you = model.you;
  const youKey = you ? (you.client_id ?? you.id) : null;
  const [youShown, setYouShown] = useState(false);
  const sawReply = useRef(false);
  const answering = isAnswering(turn);
  useEffect(() => {
    if (youKey === null) return;
    setYouShown(true);
    sawReply.current = false;
  }, [youKey]);
  useEffect(() => {
    if (answering) sawReply.current = true;
  }, [answering]);
  useEffect(() => {
    if (!youShown || answering) return;
    const ms = sawReply.current ? (reduced ? YOU_FADE_REDUCED_MS : YOU_FADE_MS) : YOU_WAIT_MS;
    const timer = setTimeout(() => setYouShown(false), ms);
    return () => clearTimeout(timer);
  }, [youShown, answering, reduced, youKey]);
  const reaction = you?.id ? model.reactions[you.id] : undefined;
  const youFiles = you ? you.files.map((f) => f.name).join("、") : "";
  const youText = !you ? "" : you.text === "" ? `你:附加了 ${youFiles}` : `你:${you.text}${youFiles ? ` · ${youFiles}` : ""}`;

  // ---- the capsule ----------------------------------------------------------------------------
  const [text, setText] = useState("");
  const [attached, setAttached] = useState<Attached[]>([]);
  const uploads = useRef(new Map<string, AbortController>());
  const input = useRef<HTMLTextAreaElement>(null);
  const logButton = useRef<HTMLButtonElement>(null);
  const bondButton = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const limits = state?.limits ?? null;

  const patch = useCallback((key: string, change: Partial<Attached>) => {
    setAttached((all) => all.map((a) => (a.key === key ? { ...a, ...change } : a)));
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (!limits || files.length === 0) return;
      const { take, refused } = admit(attached.length, files, limits);
      dispatch({ type: "notice", notice: refused ? { text: refused, tone: "error" } : null });
      const fresh: Attached[] = take.map((f) => ({
        key: newClientId(),
        name: f.name,
        size: f.size,
        kind: kindOfFile(f),
        preview: kindOfFile(f) === "image" ? URL.createObjectURL(f) : null,
        progress: 0,
        upload: null,
        error: null,
      }));
      setAttached((all) => [...all, ...fresh]);
      fresh.forEach((a, i) => {
        const file = take[i] as File;
        const ctl = new AbortController();
        uploads.current.set(a.key, ctl);
        api.upload(file, ctl.signal, (sent) => patch(a.key, { progress: sent })).then(
          (upload) => {
            uploads.current.delete(a.key);
            patch(a.key, { upload, progress: 1 });
          },
          (error: unknown) => {
            uploads.current.delete(a.key);
            if (ctl.signal.aborted) return;
            const why = isApiError(error) && error.status === 413 ? tooBig(limits) : problemOf(error);
            patch(a.key, { error: why });
            dispatch({ type: "notice", notice: { text: why, tone: "error" } });
          },
        );
      });
    },
    [api, attached.length, limits, patch, dispatch],
  );

  const removeAttached = useCallback((key: string) => {
    uploads.current.get(key)?.abort();
    uploads.current.delete(key);
    setAttached((all) => {
      const gone = all.find((a) => a.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return all.filter((a) => a.key !== key);
    });
    input.current?.focus();
  }, []);

  useEffect(
    () => () => {
      for (const ctl of uploads.current.values()) ctl.abort();
    },
    [],
  );

  const ready = readyToSend(text, attached, limits?.max_text_chars ?? 2000);
  const sendBlocked = ready === "uploading" ? "檔案還在傳" : ready === "failed" ? "有檔案沒傳上去,先拿掉它" : null;

  const submit = async () => {
    if (!open) return;
    voice.choose();
    if (ready === "empty") return;
    if (ready === "long") {
      dispatch({ type: "notice", notice: { text: "這段太長了,分幾次說", tone: "error" } });
      return;
    }
    if (ready !== "ok") return;
    const words = text.trim();
    const sent = attached;
    const files: RoomFile[] = sent.map((a) => ({ name: a.name, size: a.size, kind: a.kind, download: false }));
    setText("");
    setAttached([]);
    const result = await send(
      words,
      sent.map((a) => a.upload?.id).filter((id): id is string => typeof id === "string"),
      files,
    );
    if (result.ok) {
      for (const a of sent) if (a.preview) URL.revokeObjectURL(a.preview);
      return;
    }
    // Not sent: the words (and the files, unless they are gone) come back, if nothing new was typed.
    setText((now) => (now === "" ? words : now));
    const expired = isApiError(result.error) && result.error.status === 409;
    setAttached((now) => (now.length > 0 ? now : expired ? sent.map((a) => ({ ...a, error: problemOf(result.error) })) : sent));
  };

  const ask = (memory: RoomMemory) => {
    closePanel(false);
    setText(askAbout(memory.text));
    focusAfter.current = () => input.current?.focus();
  };

  // ---- overlays -------------------------------------------------------------------------------
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  // Focus to move once the next render is in (an overlay closed, the stage no longer inert).
  const focusAfter = useRef<(() => void) | null>(null);
  useEffect(() => {
    const move = focusAfter.current;
    focusAfter.current = null;
    move?.();
  });

  const openBacklog = useCallback(() => {
    if (!open) return;
    setPanelOpen(false);
    setBacklogOpen(true);
  }, [open]);
  const closeBacklog = useCallback(() => {
    setBacklogOpen(false);
    // Back to where it was opened from: 紀錄 on a desktop, the capsule on a phone (no 紀錄 there).
    focusAfter.current = () => {
      const log = logButton.current;
      if (log && getComputedStyle(log).display !== "none") log.focus({ preventScroll: true });
      else input.current?.focus({ preventScroll: true });
    };
  }, []);
  const closePanel = useCallback((refocus = true) => {
    setPanelOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["room", "relation"] });
    if (refocus) focusAfter.current = () => bondButton.current?.focus({ preventScroll: true });
  }, [queryClient]);

  // Her bond moved: the ring may have too.
  useEffect(() => {
    if (model.bond) void queryClient.invalidateQueries({ queryKey: ["room", "relation"] });
  }, [model.bond, queryClient]);

  // PageUp opens the backlog; Escape closes the panel (the backlog closes itself).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "PageUp" && !backlogOpen && open) {
        e.preventDefault();
        openBacklog();
      } else if (e.key === "Escape" && panelOpen && !backlogOpen) {
        closePanel();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [backlogOpen, panelOpen, open, openBacklog, closePanel]);

  // The panel closes on a press anywhere outside it and its ring.
  useEffect(() => {
    if (!panelOpen) return;
    const down = (e: globalThis.PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".hr-panel, .hr-bond-btn")) return;
      closePanel(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [panelOpen, closePanel]);

  // Wheel up over the stage opens the backlog.
  const wheel = useRef(new WheelUp());
  const stage = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (backlogOpen || panelOpen) return;
      if (wheel.current.push(e.deltaY)) openBacklog();
    };
    el.addEventListener("wheel", on, { passive: true });
    return () => el.removeEventListener("wheel", on);
  }, [backlogOpen, panelOpen, openBacklog]);

  // A swipe up from the capsule (or her line, or the handle) opens the backlog.
  const dockSwipe = useRef(new SwipeTracker(-1));
  const pressedOnLine = useRef(false);
  const tapped = useRef(0);
  const [lift, setLift] = useState(0);
  const dockDown = (e: PointerEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (e.button > 0 || target.closest("button, a")) return;
    pressedOnLine.current = target.closest(".hr-her") !== null;
    // Outside the text field: no text selection or native drag (either would cancel the pointer),
    // and the pointer stays the dock's when a mouse leaves it. A tap is then the dock's, below.
    if (!target.closest("textarea")) {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the page cannot capture.
      }
    }
    dockSwipe.current.down(e.clientX, e.clientY, e.pointerId);
  };
  const dockMove = (e: PointerEvent<HTMLDivElement>) => {
    const dy = dockSwipe.current.move(e.clientX, e.clientY, e.pointerId);
    if (dy === null) return;
    setLift(dy < 0 ? Math.max(dy * 0.35, -40) : 0);
  };
  const dockUp = (e: PointerEvent<HTMLDivElement>) => {
    const end = dockSwipe.current.up(e.clientX, e.clientY, e.pointerId, e.type === "pointercancel");
    setLift(0);
    if (end === "swipe") openBacklog();
    else if (end === "tap" && pressedOnLine.current) {
      tapped.current = Date.now();
      advance();
    }
  };
  /** Her line's own click (a screen reader's, a test's): not again right after the dock's tap. */
  const lineClick = () => {
    if (Date.now() - tapped.current > 400) advance();
  };

  // Files dragged over the page: a quiet ring, and they are attached where they are let go.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!open) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles([...(e.dataTransfer?.files ?? [])]);
      input.current?.focus();
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [open, addFiles]);

  // The dock's height, so the panel on a phone stays clear of it.
  const root = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dock.current;
    const top = root.current;
    if (!el || !top || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => top.style.setProperty("--dock-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const download = useCallback(
    (lineId: string, n: number) => {
      api.file(lineId, n).then(
        ({ blob, name }) => save(blob, name),
        (error: unknown) => dispatch({ type: "notice", notice: { text: problemOf(error), tone: "error" } }),
      );
    },
    [api, dispatch],
  );

  const vk = voiceKey(state?.voice ?? null, voiceSnap);
  const notice = model.notice;
  const overlay = backlogOpen;
  const pose = poseFor(open ? state : null, model.face);
  const face = faceFor(open ? state : null, model.face);
  const doing = open && state ? state.doing : "still";
  const figureManifest = open ? (state?.figure?.manifest ?? null) : null;

  return (
    <div ref={root} className="her-room">
      <Top member={member} home={home} />
      <main ref={stage} className="hr-stage">
        <h1 className="hr-sr">和她在一起</h1>
        <Backdrop image={open ? (state?.backdrop?.image ?? null) : null} />
        <Figure
          pose={pose}
          face={face}
          doing={doing}
          speaking={voiceSnap.speaking !== null}
          manifest={figureManifest}
          level={voiceLevel}
          make={figure}
        />
        {open && <StatusLine state={state} step={turn?.step ?? null} link={model.link} watchHref={LIVE_PAGE} />}
        {open && (
          <div inert={overlay}>
            <BondMark
              bond={relation.data?.bond ?? null}
              change={model.bond}
              open={panelOpen}
              buttonRef={bondButton}
              onToggle={() => {
                if (panelOpen) {
                  closePanel();
                  return;
                }
                setBacklogOpen(false);
                setPanelOpen(true);
              }}
            />
          </div>
        )}
        <div
          ref={dock}
          className="hr-dock"
          inert={overlay}
          data-dragging={lift ? "" : undefined}
          style={lift ? { translate: `0 ${lift}px` } : undefined}
          onPointerDown={open ? dockDown : undefined}
          onPointerMove={open ? dockMove : undefined}
          onPointerUp={open ? dockUp : undefined}
          onPointerCancel={open ? dockUp : undefined}
        >
          {notice ? (
            <p className="hr-you" data-show="" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
              {notice.text}
            </p>
          ) : (
            <p className="hr-you" data-show={youShown && you ? "" : undefined}>
              {youText}
              {reaction ? ` ${reaction}` : ""}
            </p>
          )}
          <HerLine
            content={content}
            shown={content?.kind === "line" ? reveal.shown : ""}
            revealing={content?.kind === "line" && !reveal.done}
            more={more}
            speaking={line !== null && voiceSnap.speaking === line.id}
            onAdvance={advance}
            onClick={lineClick}
            onDownload={download}
          />
          <HerAnnouncer text={announced} />
          {open && (
            <>
              <Attachments items={attached} onRemove={removeAttached} />
              <div className="hr-handle" aria-hidden="true" />
              <Capsule
                text={text}
                onText={setText}
                hint={capsuleHint(state)}
                inputRef={input}
                logRef={logButton}
                onSubmit={() => void submit()}
                onEmptyEnter={advance}
                onAttach={() => picker.current?.click()}
                onPasteFiles={addFiles}
                onOpenLog={openBacklog}
                voice={vk}
                onVoice={() => voice.toggle()}
                sendBlocked={sendBlocked}
              />
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  addFiles([...(e.target.files ?? [])]);
                  e.target.value = "";
                  input.current?.focus();
                }}
              />
            </>
          )}
        </div>
        {dragging && <DropHint />}
        {backlogOpen && (
          <Backlog
            entries={model.entries}
            older={model.older}
            loaded={model.loaded}
            reactions={model.reactions}
            onOlder={loadOlder}
            onClose={closeBacklog}
            onExclude={exclude}
            onDownload={download}
          />
        )}
        {panelOpen && (
          <div inert={overlay}>
            <Relation
              relation={relation.data}
              failed={relation.isError}
              onClose={() => closePanel()}
              onAsk={ask}
              onForget={async (id) => (await api.forgetMemory(id)).forgotten}
            />
          </div>
        )}
      </main>
    </div>
  );
}

/** The page, on this connection's Core (or the dev demo's stand-in). */
export function RoomPage({ member, home }: { member?: MemberSession | null; home: string }) {
  const { api: core, client } = useConnection();
  const api = useMemo(() => roomApiFor(core, client), [core, client]);
  const asked = useQuery({
    queryKey: ["member", "session"],
    queryFn: ({ signal }) => core.rpc.member.session(undefined, { signal }),
    enabled: member === undefined,
  });
  return <Room api={api} member={member ?? asked.data ?? null} home={home} />;
}

export default RoomPage;
