import type { ReactNode } from "react";
import type { RoomState } from "@miyoria/contracts/api";
import type { RoomLink } from "./room-store";
import { doingOf, linkWord, pleased } from "./room-text";

/** Her small drawn face beside the mood word: a smile, or a flat mouth. */
function MoodFace({ smile }: { smile: boolean }) {
  return (
    <svg className="hr-face" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" />
      {smile ? (
        <>
          <path d="M5.6 6.4v.2M10.4 6.4v.2" />
          <path d="M5.2 9.6c1.5 1.7 4.1 1.7 5.6 0" />
        </>
      ) : (
        <>
          <path d="M4.8 6.6h2.2M9 6.6h2.2" />
          <path d="M5.8 10.6l4.6-.6" />
        </>
      )}
    </svg>
  );
}

function Dot() {
  return (
    <span className="hr-dot" aria-hidden="true">
      ·
    </span>
  );
}

/** The one line at the top left: her mood, what she is doing, and the stream when it is lost. */
export function StatusLine({
  state,
  step,
  link,
  watchHref,
}: {
  state: RoomState | null;
  step: string | null;
  link: RoomLink;
  watchHref: string;
}) {
  const lost = linkWord(link);
  if (!state) {
    return (
      <p className="hr-status" aria-live="polite">
        {lost}
      </p>
    );
  }
  const doing = state.open ? doingOf(state, step, watchHref) : null;
  const mood = state.open && !state.paused && state.doing !== "offline" ? state.mood : null;
  const parts: ReactNode[] = [];
  if (doing?.singing) {
    parts.push(
      <span key="doing" className="inline-flex items-center gap-2">
        <span className="hr-eq" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {doing.text}
      </span>,
    );
  } else {
    if (mood) {
      parts.push(
        <span key="mood" className="inline-flex items-center gap-2">
          <MoodFace smile={pleased(mood.word)} />
          {mood.word}
        </span>,
      );
    }
    if (doing) parts.push(<span key="doing">{doing.text}</span>);
  }
  if (doing?.link) {
    parts.push(
      <a key="link" href={doing.link.href}>
        {doing.link.label}
      </a>,
    );
  }
  if (lost) parts.push(<span key="lost">{lost}</span>);
  return (
    <p className="hr-status" aria-live="polite">
      {parts.flatMap((p, i) => (i === 0 ? [p] : [<Dot key={`d${i}`} />, p]))}
    </p>
  );
}
