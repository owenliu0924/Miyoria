import { useEffect, useRef } from "react";
import type { RoomDoing, RoomFigureFace } from "@miyoria/contracts/api";
import { type HerFigure, type Pose, loopFigure } from "./figure";
import { live2dFigure } from "./live2d";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export interface FigureProps {
  pose: Pose;
  face: RoomFigureFace;
  doing: RoomDoing | "still";
  speaking: boolean;
  /** Her Live2D figure's manifest when the Core serves it (`state.figure`); `null`: the loops. */
  manifest: string | null;
  /** Her voice's level now, 0..1 (read on every frame while she speaks). */
  level: () => number;
  /** A figure of the caller's own (tests); it takes the place of both. */
  make?: () => HerFigure;
}

/** Where her figure stands: the whole stage, behind everything else. */
export function Figure({ pose, face, doing, speaking, manifest, level, make }: FigureProps) {
  const box = useRef<HTMLDivElement>(null);
  const figure = useRef<HerFigure | null>(null);
  const latest = useRef({ pose, face, doing, speaking, level });
  latest.current = { pose, face, doing, speaking, level };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const f = make
      ? make()
      : manifest
        ? live2dFigure({ manifest, reduced, level: () => latest.current.level() })
        : loopFigure({ reduced });
    figure.current = f;
    f.mount(el);
    const now = latest.current;
    f.show(now.pose);
    f.feel?.(now.face, now.doing);
    if (now.speaking) f.speaking(true);
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

  return <div ref={box} className="hr-figure" aria-hidden="true" data-pose={pose} data-face={face} />;
}
