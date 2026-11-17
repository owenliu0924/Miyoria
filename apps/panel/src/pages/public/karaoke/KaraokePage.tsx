// `/karaoke`: a member sings on their own (docs/design/karaoke.md, the first milestone). Pick a
// song (or ask for one), measure the device's latency once, sing over the backing track in this
// browser, and get the system's score; she comments on it in Discord when she wants to.
// Single player only: no rooms, nothing live, no coins.

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KaraokeOverview, KaraokeSongView, MemberSession } from "@miyoria/contracts/api";
import { useApi } from "@/app/connection";
import { Logo } from "@/components/logo";
import { Page } from "@/components/page";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { createEngine, type KaraokeEngine } from "./audio";
import { Calibration } from "./Calibration";
import {
  deviceKey,
  lastDevice,
  latencyFor,
  loadLatency,
  type StoredLatency,
  saveLatency,
} from "./latency";
import { isOff, useOverview } from "./queries";
import { Result } from "./Result";
import { type Finished, Singing } from "./Singing";
import { AskForSong, LatencyBlock, RecentResults, SongList } from "./SongList";
import { micError, missingSupport } from "./support";

type View =
  | { kind: "list" }
  | { kind: "calibrate"; after: KaraokeSongView | null }
  | { kind: "sing"; song: KaraokeSongView }
  | { kind: "result"; session: string; title: string; artist: string | null; song: string; pending?: Finished };

function Header({ member, home }: { member: MemberSession | null; home: string }) {
  return (
    <header className="glass-dock sticky top-0 z-30 flex min-h-13 items-center gap-2.5 border-b px-4 py-2 sm:px-7">
      <Logo className="size-5 shrink-0 text-primary" />
      <p className="text-[15px] font-semibold">Miyoria</p>
      <span aria-hidden className="text-muted-foreground">
        /
      </span>
      <h1 className="text-[15px] font-semibold">唱歌</h1>
      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={home}>
            <ArrowLeft aria-hidden />
            回到你的頁面
          </a>
        </Button>
        {member?.avatar_url && <img src={member.avatar_url} alt="" className="size-6 rounded-full" />}
        {member && <span className="hidden max-w-40 truncate text-[13px] sm:inline">{member.name}</span>}
      </div>
    </header>
  );
}

/** The latency this browser keeps for the microphone last used, or for `key`. */
function keptLatency(key: string | null): StoredLatency | null {
  return key ? loadLatency(key) : null;
}

function Karaoke({ overview }: { overview: KaraokeOverview }) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [key, setKey] = useState<string | null>(() => lastDevice());
  const [stored, setStored] = useState<StoredLatency | null>(() => keptLatency(lastDevice()));
  const [estimate, setEstimate] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const engineRef = useRef<KaraokeEngine | null>(null);
  const unsupported = missingSupport();

  const engine = useCallback(() => {
    engineRef.current ??= createEngine();
    return engineRef.current;
  }, []);
  useEffect(
    () => () => {
      engineRef.current?.close();
      engineRef.current = null;
    },
    [],
  );

  const latency = latencyFor(stored, estimate ?? engineRef.current?.estimateLatencyMs() ?? 40);

  const sing = async (song: KaraokeSongView) => {
    setBlocked(null);
    const why = missingSupport();
    if (why) {
      setBlocked(why);
      return;
    }
    setOpening(true);
    try {
      const audio = engine();
      const mic = await audio.openMic();
      setEstimate(audio.estimateLatencyMs());
      const k = deviceKey(mic);
      const kept = loadLatency(k);
      setKey(k);
      setStored(kept);
      setView(kept ? { kind: "sing", song } : { kind: "calibrate", after: song });
    } catch (e) {
      setBlocked(micError(e));
    } finally {
      setOpening(false);
    }
  };

  const calibrate = () => {
    setBlocked(null);
    const why = missingSupport();
    if (why) {
      setBlocked(why);
      return;
    }
    setView({ kind: "calibrate", after: null });
  };

  const findSong = (id: string) => overview.songs.find((s) => s.id === id && s.state === "ready");

  if (view.kind === "calibrate") {
    return (
      <Page>
        <Calibration
          engine={engine}
          deviceKey={key}
          estimate={estimate ?? engine().estimateLatencyMs()}
          next={view.after?.title ?? null}
          onKey={setKey}
          onSaved={setStored}
          onBack={() => setView({ kind: "list" })}
          onContinue={() => {
            const after = view.after;
            if (!after) {
              setView({ kind: "list" });
              return;
            }
            // Skipped: the estimate stands, and the question is not asked again on this device.
            if (key && !loadLatency(key)) {
              const kept: StoredLatency = {
                latency_ms: latency.latency_ms,
                measured: false,
                floor: null,
                at: new Date().toISOString(),
              };
              saveLatency(key, kept);
              setStored(kept);
            }
            setView({ kind: "sing", song: after });
          }}
        />
      </Page>
    );
  }

  if (view.kind === "sing") {
    return (
      <Page>
        <Singing
          key={view.song.id}
          engine={engine}
          song={view.song}
          latency={latency}
          floor={stored?.floor ?? null}
          onFinished={(f) =>
            setView({
              kind: "result",
              session: f.session,
              title: f.song.title,
              artist: f.song.artist,
              song: f.song.id,
              pending: f,
            })
          }
          onQuit={() => setView({ kind: "list" })}
          onCalibrate={() => setView({ kind: "calibrate", after: view.song })}
        />
      </Page>
    );
  }

  if (view.kind === "result") {
    const again = findSong(view.song);
    return (
      <Page>
        <Result
          key={view.session}
          session={view.session}
          title={view.title}
          artist={view.artist}
          pending={view.pending}
          onAgain={() => (again ? void sing(again) : setView({ kind: "list" }))}
          onBack={() => setView({ kind: "list" })}
        />
      </Page>
    );
  }

  return (
    <Page
      rail={
        <>
          <AskForSong overview={overview} />
          <LatencyBlock latency={key ? latency : null} onCalibrate={calibrate} />
          <RecentResults
            recent={overview.recent}
            onOpen={(r) => setView({ kind: "result", session: r.session, title: r.title, artist: null, song: r.song })}
          />
        </>
      }
    >
      {(blocked ?? unsupported) && (
        <p role="alert" className="flex items-center gap-2 text-[13px]">
          <CircleAlert aria-hidden className="size-4 shrink-0 text-primary" />
          {blocked ?? unsupported}
        </p>
      )}
      <SongList overview={overview} onSing={(s) => void sing(s)} busy={opening} />
    </Page>
  );
}

function Closed({ children }: { children: string }) {
  return (
    <Page>
      <Card aria-label="唱歌">
        <CardHeader>
          <CardTitle>唱歌</CardTitle>
        </CardHeader>
        <EmptyLine>{children}</EmptyLine>
      </Card>
    </Page>
  );
}

function Body() {
  const overview = useOverview();
  if (overview.isPending) {
    return (
      <Page>
        <SkeletonRows count={5} />
      </Page>
    );
  }
  if (overview.isError) {
    if (isOff(overview.error)) return <Closed>現在沒有開放唱歌</Closed>;
    return (
      <Page>
        <ErrorLine error={overview.error} onRetry={() => void overview.refetch()} />
      </Page>
    );
  }
  if (!overview.data.open) return <Closed>現在沒有開放唱歌</Closed>;
  return <Karaoke overview={overview.data} />;
}

/**
 * The page. `member`: who is logged in, when the caller knows (else it is asked); `home`: their
 * own page, where the header's way back goes.
 */
export function KaraokePage({ member, home }: { member?: MemberSession | null; home: string }) {
  const api = useApi();
  const asked = useQuery({
    queryKey: ["member", "session"],
    queryFn: ({ signal }) => api.rpc.member.session(undefined, { signal }),
    enabled: member === undefined,
    retry: false,
  });
  const who = member ?? asked.data ?? null;
  return (
    <div className="flex min-h-svh flex-col">
      <Header member={who} home={home} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Body />
      </main>
    </div>
  );
}

export default KaraokePage;
