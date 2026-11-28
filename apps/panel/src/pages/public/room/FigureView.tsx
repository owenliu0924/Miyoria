import { useEffect, useRef } from "react";
import type { RoomDoing, RoomFigureFace } from "@miyoria/contracts/api";
import { type FigureCue, type HerFigure, type Pose, noFigure } from "./figure";
import { live2dFigure } from "./live2d";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export interface FigureProps {
  pose: Pose;
  face: RoomFigureFace;
  doing: RoomDoing | "still";
  speaking: boolean;
  /** She is working out her reply. */
  thinking?: boolean;
  /** Her line as far as it is shown while it still comes in; `null` once it is whole or there is none. */
  revealing?: string | null;
  /** Her latest reaction; a new `n` plays it (the one there at the start is not played). */
  cue?: FigureCue | null;
  /** Her Live2D figure's manifest when the Core serves it (`state.figure`); `null`: no figure. */
  manifest: string | null;
  /** Her voice's level now, 0..1 (read on every frame while she speaks). */
  level: () => number;
  /** A figure of the caller's own (tests); it takes the place of the Live2D one. */
  make?: () => HerFigure;
}

/** Where her figure stands: the whole stage, behind everything else. */
export function Figure({
  pose,
  face,
  doing,
  speaking,
  thinking = false,
  revealing = null,
  cue = null,
  manifest,
  level,
  make,
}: FigureProps) {
  const box = useRef<HTMLDivElement>(null);
  const figure = useRef<HerFigure | null>(null);
  const latest = useRef({ pose, face, doing, speaking, thinking, revealing, level });
  latest.current = { pose, face, doing, speaking, thinking, revealing, level };
  const played = useRef(cue?.n ?? 0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const f = make
      ? make()
      : manifest
        ? live2dFigure({ manifest, reduced, level: () => latest.current.level() })
        : noFigure();
    figure.current = f;
    f.mount(el);
    const now = latest.current;
    f.show(now.pose);
    f.thinking?.(now.thinking);
    f.feel?.(now.face, now.doing);
    if (now.speaking) f.speaking(true);
    if (now.revealing !== null) f.mouthing?.(now.revealing);
    return () => {
      f.dispose();
      figure.current = null;
    };
  }, [make, manifest]);

  useEffect(() => {
    figure.current?.show(pose);
  }, [pose]);

  useEffect(() => {
    figure.current?.feel?.(face, doing);
  }, [face, doing]);

  useEffect(() => {
    figure.current?.speaking(speaking);
  }, [speaking]);

  useEffect(() => {
    figure.current?.thinking?.(thinking);
  }, [thinking]);

  useEffect(() => {
    figure.current?.mouthing?.(revealing);
  }, [revealing]);

  useEffect(() => {
    if (!cue || cue.n === played.current) return;
    played.current = cue.n;
    figure.current?.react?.(cue.kind);
  }, [cue]);

  return <div ref={box} className="hr-figure" aria-hidden="true" data-pose={pose} data-face={face} />;
}
