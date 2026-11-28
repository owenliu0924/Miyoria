import { useEffect, useState } from "react";

/** The hour's light in her room: where the window's light comes from and its colour (`room.css`). */
export type RoomLight = "dawn" | "day" | "dusk" | "night";

/** The light at an hour of the member's own clock. */
export function lightAt(hour: number): RoomLight {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 16) return "day";
  if (hour >= 16 && hour < 19) return "dusk";
  return "night";
}

/** How often the hour is read again, ms. */
const LIGHT_CHECK_MS = 5 * 60_000;

export interface BackdropProps {
  /** The owner's picture for the room (`state.backdrop`); `null`: the page's own room. */
  image: string | null;
  /** Tests: the hour now. */
  hour?: () => number;
}

/**
 * What stands behind her: the owner's picture when there is one, dimmed and a little out of focus
 * so she stays in front of it; otherwise a wall with the light of a window on it, in the colour of
 * the member's hour. A picture that will not load leaves the wall.
 */
export function Backdrop({ image, hour = () => new Date().getHours() }: BackdropProps) {
  const [light, setLight] = useState<RoomLight>(() => lightAt(hour()));
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setLight(lightAt(hour())), LIGHT_CHECK_MS);
    return () => clearInterval(timer);
  }, [hour]);

  const picture = image !== null && failed !== image ? image : null;
  return (
    <div className="hr-backdrop" data-light={light} data-picture={picture ? "" : undefined} aria-hidden="true">
      <div className="hr-wall">
        <div className="hr-window" />
        <div className="hr-floor" />
      </div>
      {picture && (
        <img
          className="hr-picture"
          src={picture}
          alt=""
          decoding="async"
          draggable={false}
          data-shown={loaded === picture ? "" : undefined}
          onLoad={() => setLoaded(picture)}
          onError={() => setFailed(picture)}
        />
      )}
    </div>
  );
}
