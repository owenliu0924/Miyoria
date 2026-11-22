import { ArrowLeft, CircleAlert, LogOut } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { MemberSession, PublicDay, PublicSong } from "@miyoria/contracts/api";
import { ChartBlock, ChartEmpty, ColumnChart } from "@/components/charts/charts";
import { Logo } from "@/components/logo";
import { Page } from "@/components/page";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Dot, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtInt } from "@/lib/format";
import { SITE_NAME } from "@/lib/site-name";
import { cn } from "@/lib/utils";
import { WORLD } from "@/lib/world";
import { CardSection } from "./CardSection";
import { CardsArea } from "./cards/CardsArea";
import { Exchange } from "./Exchange";
import { Transfer } from "./Extras";
import { GiftsCard, GiftsReceived } from "./Gifts";
import { GitHubLinkCard } from "./GitHubLink";
import { KaraokeLink } from "./karaoke/link";
import { LiveStage } from "./live/LiveStage";
import { MadeForMe } from "./MadeForMe";
import { Market } from "./Market";
import {
  DAY_MS,
  localMidnight,
  MemberActivity,
  MemberMemories,
  MemberProfile,
  MemberSongs,
  RequestSongCard,
  YourData,
} from "./Member";
import { MemberSpaceBar, MemberSpaceProvider } from "./member-space";
import {
  MEMBER_TABS,
  type MemberTab,
  type MemberTabDef,
  memberTabIn,
  memberTabPath,
  OWN_PATH,
  type Row,
  colSections,
  type SectionKey,
} from "./member-tabs";
import { Predictions, QuestsCard } from "./Play";
import { STATE, stateLabel, usePublicSongs, usePublicStatus } from "./status";
import {
  BoardSection,
  BountiesSection,
  EarnSection,
  FortuneSection,
  RecentSection,
  ShopSection,
  WalletCard,
} from "./Wallet";

export { STATE, stateLabel, usePublicSongs, usePublicStatus };

const duration = (s: number | null) =>
  s === null ? null : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Label over value, spaced, no cell walls: the panel's strip of facts. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

const title = (s: PublicSong) => s.title ?? "歌名還不知道";

/** What she is doing and what today came to. */
function Now() {
  const status = usePublicStatus();
  const songs = usePublicSongs();
  return (
    <Card aria-label="現在">
      <CardHeader>
        <CardTitle>現在</CardTitle>
      </CardHeader>
      <QueryView query={status} skeleton={<SkeletonRows count={1} />}>
        {(s) => (
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Fact label="她">{stateLabel(s)}</Fact>
            {songs.data?.playing && <Fact label="正在唱">{title(songs.data.playing)}</Fact>}
            <Fact label="直播">{s.live ? "直播中" : "沒有"}</Fact>
            <Fact label="語音">{s.in_voice ? "在頻道裡" : "沒有"}</Fact>
            <Fact label="今天唱了">{s.today.songs_sung} 首</Fact>
            <Fact label="今天直播">{s.today.hours_live} 小時</Fact>
            <Fact label="今天在語音">{s.today.hours_in_voice} 小時</Fact>
          </dl>
        )}
      </QueryView>
    </Card>
  );
}

type Measure = "songs" | "live" | "voice";

const MEASURES: Record<Measure, { label: string; unit: string; pick: (d: PublicDay) => number; color: string }> = {
  songs: { label: "唱歌", unit: "首", pick: (d) => d.songs_sung, color: "var(--chart-1)" },
  live: { label: "直播", unit: "小時", pick: (d) => d.hours_live, color: "var(--chart-2)" },
  voice: { label: "語音", unit: "小時", pick: (d) => d.hours_in_voice, color: "var(--chart-2)" },
};

const oneDecimal = (v: number) => (Math.round(v * 10) / 10).toString();

function HerDaysChart({ days }: { days: PublicDay[] }) {
  const [measure, setMeasure] = useState<Measure>("songs");
  const m = MEASURES[measure];
  const total = days.reduce((n, d) => n + m.pick(d), 0);
  const format = measure === "songs" ? fmtInt : oneDecimal;
  const columns = days.map((d) => ({ t: localMidnight(d.date), values: { v: m.pick(d) } }));
  return (
    <ChartBlock
      title="她這兩週"
      value={format(total)}
      unit={m.unit}
      aside={`近 ${days.length} 天${m.label}`}
      action={
        <Segmented
          label="看哪一項"
          value={measure}
          onChange={setMeasure}
          options={(Object.keys(MEASURES) as Measure[]).map((k) => ({ value: k, label: MEASURES[k].label }))}
        />
      }
    >
      {total === 0 ? (
        <ChartEmpty height={168}>這兩週還沒有{m.label}的紀錄</ChartEmpty>
      ) : (
        <ColumnChart
          columns={columns}
          series={[{ key: "v", label: m.label, color: m.color }]}
          label={`近 ${days.length} 天每天${m.label}(${m.unit})`}
          bucketMs={DAY_MS}
          height={168}
          format={format}
          integer={measure === "songs"}
        />
      )}
    </ChartBlock>
  );
}

function HerDays() {
  const status = usePublicStatus();
  return (
    <Card aria-label="她這兩週">
      <QueryView query={status} skeleton={<SkeletonRows count={4} />}>
        {(s) =>
          s.days ? <HerDaysChart days={s.days} /> : <ChartEmpty height={168}>這個 Core 還沒有每日紀錄</ChartEmpty>
        }
      </QueryView>
    </Card>
  );
}

function SongRow({ song, tone, aside }: { song: PublicSong; tone?: Tone; aside?: string }) {
  return (
    <li className="flex items-center gap-2.5 py-(--row-y)">
      {tone && <Dot tone={tone} pulse={tone === "brand"} />}
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{title(song)}</span>
        {song.artist && <span className="ml-1.5 text-muted-foreground">{song.artist}</span>}
      </p>
      {aside && <span className="shrink-0 text-xs text-muted-foreground">{aside}</span>}
      {song.duration_s !== null && (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {duration(song.duration_s)}
        </span>
      )}
    </li>
  );
}

function Songs() {
  const songs = usePublicSongs();
  return (
    <Card aria-label="歌單">
      <CardHeader>
        <CardTitle>歌單</CardTitle>
      </CardHeader>
      <QueryView query={songs} skeleton={<SkeletonRows count={3} />}>
        {(s) => (
          <>
            {!s.playing && s.upcoming.length === 0 ? (
              <EmptyLine>歌單是空的</EmptyLine>
            ) : (
              <ul className="divide-y divide-line-soft">
                {s.playing && <SongRow song={s.playing} tone="brand" aside="正在唱" />}
                {s.upcoming.map((song, i) => (
                  <SongRow key={i} song={song} aside={song.ready ? "準備好了" : "準備中"} />
                ))}
              </ul>
            )}
            {s.recent.length > 0 && (
              <div className="mt-3">
                <h3 className="text-[13px] font-medium">剛唱完</h3>
                <ul className="divide-y divide-line-soft">
                  {s.recent.map((song, i) => (
                    <SongRow key={i} song={song} />
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </QueryView>
    </Card>
  );
}

function Header({ member, onLogout, onBack }: { member: MemberSession; onLogout: () => void; onBack?: () => void }) {
  const status = usePublicStatus();
  const now = status.data;
  return (
    <header className="glass-dock z-30 flex min-h-13 items-center gap-2.5 border-b px-4 py-2 sm:px-7 md:sticky md:top-0 md:h-13">
      <Logo className="size-5 shrink-0 text-primary" />
      <h1 className="text-[15px] font-semibold">{SITE_NAME}</h1>
      {now && (
        <p className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          <Dot tone={STATE[now.state].tone} pulse={STATE[now.state].pulse} />
          <span className="truncate">{stateLabel(now)}</span>
        </p>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <KaraokeLink />
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft aria-hidden />
            回到管理面板
          </Button>
        )}
        {member.avatar_url && <img src={member.avatar_url} alt="" className="size-6 rounded-full" />}
        <span className="hidden max-w-40 truncate text-[13px] sm:inline">{member.name}</span>
        <Button variant="ghost" size="icon-sm" aria-label="登出" onClick={onLogout}>
          <LogOut />
        </Button>
      </div>
    </header>
  );
}

/**
 * Every block of the member area, by its key in `member-tabs.ts`: its region name (what a test
 * and a screen reader find it by) and what draws it. A key without a block, or a block without a
 * tab, does not compile or fails `member-tabs.test.tsx`.
 */
export const SECTIONS: Record<SectionKey, { label: string; render: (member: MemberSession) => ReactNode }> = {
  profile: { label: "她眼中的你", render: (m) => <MemberProfile member={m} /> },
  wallet: { label: "錢包", render: () => <WalletCard /> },
  quests: { label: "今天的任務", render: () => <QuestsCard /> },
  now: { label: "現在", render: () => <Now /> },
  activity: { label: "你和她說的話", render: () => <MemberActivity /> },
  herDays: { label: "她這兩週", render: () => <HerDays /> },
  memories: { label: "一起的回憶", render: () => <MemberMemories /> },
  github: { label: "GitHub", render: () => <GitHubLinkCard /> },
  yourData: { label: "你的資料", render: () => <YourData /> },
  live: { label: "現場", render: (m) => <LiveStage member={m} /> },
  giftForm: { label: "送她禮物", render: () => <GiftsCard /> },
  requestSong: { label: "點歌", render: () => <RequestSongCard /> },
  yourSongs: { label: "你點的歌", render: () => <MemberSongs /> },
  songs: { label: "歌單", render: () => <Songs /> },
  shop: { label: "商店", render: () => <ShopSection /> },
  giftsReceived: { label: "她收到的東西", render: () => <GiftsReceived /> },
  madeForMe: { label: "她做給我的", render: () => <MadeForMe /> },
  earn: { label: "怎麼賺", render: () => <EarnSection /> },
  recent: { label: "最近", render: () => <RecentSection /> },
  transfer: { label: "轉給朋友", render: () => <Transfer /> },
  board: { label: "贊助排行榜", render: () => <BoardSection /> },
  card: { label: "她給你的卡", render: () => <CardSection /> },
  fortune: { label: "今日籤詩", render: () => <FortuneSection /> },
  album: { label: "卡冊", render: () => <CardsArea /> },
  predictions: { label: "預測", render: () => <Predictions /> },
  bounties: { label: "她的懸賞", render: () => <BountiesSection /> },
  market: { label: "市集", render: () => <Market /> },
  exchange: { label: WORLD.exchange_name, render: () => <Exchange /> },
};

function Section({ id, member }: { id: SectionKey; member: MemberSession }) {
  return <>{SECTIONS[id].render(member)}</>;
}

function TabRow({ row, member }: { row: Row; member: MemberSession }) {
  if ("full" in row) return <Section id={row.full} member={member} />;
  return (
    <div className={cn("grid items-start gap-(--stage-gap)", row.template ?? "lg:grid-cols-2")}>
      {row.cols.map((col) => (
        <div
          key={colSections(col).join()}
          className={cn("grid min-w-0 content-start gap-(--stage-gap)", !Array.isArray(col) && col.span && "lg:row-span-2")}
        >
          {colSections(col).map((id) => (
            <Section key={id} id={id} member={member} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One tab's blocks; only the open tab is mounted, so only its queries and pushed topics run. */
function TabBody({ tab, member }: { tab: MemberTabDef; member: MemberSession }) {
  return (
    <div data-member-tab={tab.id} className="member-tab grid gap-(--stage-gap)">
      {tab.perServer && <MemberSpaceBar />}
      {tab.rows.map((row, i) => (
        <TabRow key={i} row={row} member={member} />
      ))}
      {/* Shown by CSS only while no block of the tab has anything to show (`.member-tab-empty`). */}
      <EmptyLine className="member-tab-empty">{tab.empty}</EmptyLine>
    </div>
  );
}

/** A plain left click follows the tab in the page; any other (a new tab, a copied link) is the browser's. */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * The tab row under the header: the admin panel's underlined frame row, with each tab a link to
 * its own address. Arrow keys move between tabs (Radix); the open tab is kept in view when the
 * row scrolls on a narrow phone.
 */
function MemberTabs({ tab, onPick }: { tab: MemberTab; onPick: (t: MemberTab) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = list.current;
    const on = row?.querySelector<HTMLElement>('[data-state="active"]');
    if (!row || !on) return;
    const left = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2;
    row.scrollTo?.({ left: Math.max(0, left) });
  }, [tab]);
  return (
    <TabsList ref={list} aria-label="我的頁面" className="z-20 md:top-13">
      {MEMBER_TABS.map((t) => (
        <TabsTrigger key={t.id} value={t.id} asChild>
          <a
            href={memberTabPath(t.id)}
            onClick={(e) => {
              if (!plainClick(e.nativeEvent)) return;
              e.preventDefault();
              onPick(t.id);
            }}
          >
            {t.label}
          </a>
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/**
 * The page of someone logged in without panel access, in tabs (`member-tabs.ts`): the overview of
 * her and them, then giving and doing things with her, the coins, the cards, the games and the
 * exchange. Each tab is its own address under `/me`; only the open one is mounted. Nothing here
 * talks to an admin route, and the admin shell, its navigation and its event stream are not
 * mounted.
 */
export function PublicSite({
  member,
  notice,
  onLogout,
  onBack,
  path = "/",
  navigate,
}: {
  member: MemberSession;
  /** What a failed login came back with. */
  notice?: string | null;
  onLogout: () => void;
  /** An admin looking at their own page: the way back to the admin panel. */
  onBack?: () => void;
  /** The address (path and query) the page is at. */
  path?: string;
  /** Goes to another address in the page; `replace` does not add to the history. */
  navigate?: (to: string, replace?: boolean) => void;
}) {
  const found = memberTabIn(path);
  const [local, setLocal] = useState<MemberTab>(found ?? "overview");
  const tabId = navigate ? (found ?? "overview") : local;
  const tab = MEMBER_TABS.find((t) => t.id === tabId) ?? (MEMBER_TABS[0] as MemberTabDef);

  // An address under `/me/` that is no tab (an old or mistyped link) goes to the overview.
  useEffect(() => {
    if (found === null) navigate?.(OWN_PATH, true);
  }, [found, navigate]);

  useEffect(() => {
    document.title = `${tab.label} · ${SITE_NAME}`;
  }, [tab.label]);

  // Radix picks a tab on the press and the link is clicked after it: one address for both.
  const shown = useRef(tab.id);
  shown.current = tab.id;
  const pick = (t: MemberTab) => {
    if (t === shown.current) return;
    shown.current = t;
    if (navigate) navigate(memberTabPath(t));
    else setLocal(t);
    // A new tab starts at its top; the row itself stays under the header.
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  };

  return (
    <MemberSpaceProvider>
      <div className="flex min-h-svh flex-col">
        <Header member={member} onLogout={onLogout} onBack={onBack} />
        <Tabs value={tab.id} onValueChange={(v) => pick(v as MemberTab)}>
          <MemberTabs tab={tab.id} onPick={pick} />
          <main className="flex min-w-0 flex-1 flex-col">
            <Page>
              {notice && (
                <p role="alert" className="flex items-center gap-2 text-[13px]">
                  <CircleAlert aria-hidden className="size-4 shrink-0 text-primary" />
                  {notice}
                </p>
              )}
              {MEMBER_TABS.map((t) => (
                <TabsContent key={t.id} value={t.id}>
                  <TabBody tab={t} member={member} />
                </TabsContent>
              ))}
            </Page>
          </main>
        </Tabs>
      </div>
    </MemberSpaceProvider>
  );
}
