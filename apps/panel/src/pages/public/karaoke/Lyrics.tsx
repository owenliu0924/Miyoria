// The lyrics under the lane: the line being sung and the next one. An aligned line lights up piece
// by piece as it is sung (dim to bright, no colour of its own); a line without times shows as a
// whole. Readings sit above the words when the viewer turned them on. Lyrics that are what the
// recogniser heard carry 「聽寫」; a looked-up line that did not match what was heard is
// underlined with dots.

import type {
  WorkersKaraokeLineV2,
  WorkersKaraokeLyricsV2,
  WorkersKaraokePiece,
} from "@miyoria/contracts/workers/karaoke";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { lyricAt } from "./lane";
import {
  isDoubtful,
  lineProgress,
  type ReadingMode,
  readingLabel,
  readingModes,
  rubyOf,
} from "./lyric-text";

export function Lyrics({
  lyrics,
  now,
  loaded,
  mode,
  onMode,
}: {
  lyrics: WorkersKaraokeLyricsV2 | null;
  now: number;
  loaded: boolean;
  mode: ReadingMode;
  onMode: (m: ReadingMode) => void;
}) {
  const lines = lyrics?.lines ?? [];
  if (lines.length === 0) {
    return (
      <div className="grid min-h-20 content-start">
        <p className="text-[13px] text-muted-foreground">{loaded ? "沒有找到歌詞" : " "}</p>
      </div>
    );
  }
  const modes = readingModes(lyrics);
  const shown: ReadingMode = modes.includes(mode) ? mode : "off";
  const at = lyricAt(lines, now);
  const current = at.current === null ? null : (lines[at.current] ?? null);
  const following = at.next === null ? null : (lines[at.next] ?? null);
  const heard = lyrics?.source === "heard";
  return (
    <div className="grid gap-2">
      {(heard || modes.length > 0) && (
        <div className="flex flex-wrap items-center gap-3">
          {heard && (
            <Badge title="歌詞是聽出來的,可能有錯" aria-label="聽寫:歌詞是聽出來的,可能有錯">
              聽寫
            </Badge>
          )}
          {modes.length > 0 && (
            <Segmented<ReadingMode>
              label="讀音"
              value={shown}
              onChange={onMode}
              options={(["off", ...modes] as ReadingMode[]).map((m) => ({
                value: m,
                label: readingLabel(m, lyrics?.language ?? null),
              }))}
              className="ml-auto"
            />
          )}
        </div>
      )}
      <div aria-live="off" className="grid min-h-20 content-start gap-1.5">
        <LineText
          line={current}
          now={now}
          mode={shown}
          className={cn("text-2xl font-semibold tracking-[-0.01em] text-balance", shown !== "off" ? "min-h-12" : "min-h-8")}
        />
        <LineText line={following} now={null} mode={shown} className="min-h-6 text-[15px] text-muted-foreground" />
      </div>
    </div>
  );
}

/** One line; `now` lights its pieces as they are sung (`null`: the line to come, not lit). */
function LineText({
  line,
  now,
  mode,
  className,
}: {
  line: WorkersKaraokeLineV2 | null;
  now: number | null;
  mode: ReadingMode;
  className?: string;
}) {
  if (line === null) return <p className={className}> </p>;
  const doubtful = isDoubtful(line);
  const progress = now === null ? null : lineProgress(line, now);
  const pieces = line.pieces;
  return (
    <p
      className={cn(
        className,
        mode !== "off" && "leading-[1.9]",
        doubtful && "underline decoration-muted-foreground/50 decoration-dotted underline-offset-[0.28em]",
      )}
      title={doubtful ? "這一行和聽到的不太一樣" : undefined}
    >
      {pieces === null
        ? line.text
        : pieces.map((p, i) => (
            <Piece key={i} piece={p} ruby={rubyOf(p, mode)} at={progress === null ? null : (progress[i] ?? 0)} />
          ))}
    </p>
  );
}

function Piece({ piece, ruby, at }: { piece: WorkersKaraokePiece; ruby: string | null; at: number | null }) {
  const text = at === null ? piece.text : <Lit text={piece.text} at={at} />;
  if (ruby === null || !piece.sung) return <>{text}</>;
  return (
    <ruby className="[ruby-position:over]">
      {text}
      <rt className="text-[0.42em] font-normal tracking-normal text-muted-foreground">{ruby}</rt>
    </ruby>
  );
}

/** The piece dim, and bright over the share already sung. */
function Lit({ text, at }: { text: string; at: number }) {
  return (
    <span className="relative inline-block whitespace-pre">
      <span className="text-muted-foreground/60">{text}</span>
      <span
        aria-hidden
        data-lit={at >= 1 ? "all" : at > 0 ? "part" : "none"}
        className="absolute inset-y-0 left-0 overflow-hidden whitespace-pre text-foreground transition-[width] duration-100 ease-linear motion-reduce:transition-none"
        style={{ width: `${Math.round(at * 1000) / 10}%` }}
      >
        {text}
      </span>
    </span>
  );
}
