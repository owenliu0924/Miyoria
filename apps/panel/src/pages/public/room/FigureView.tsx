import { useEffect, useRef } from "react";
import { type HerFigure, type Pose, loopFigure } from "./figure";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Where her figure stands: the whole stage, behind everything else. `make` swaps the figure. */
export function Figure({ pose, speaking, make }: { pose: Pose; speaking: boolean; make?: () => HerFigure }) {
  const box = useRef<HTMLDivElement>(null);
  const figure = useRef<HerFigure | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const f = make ? make() : loopFigure({ reduced });
    figure.current = f;
    f.mount(el);
    return () => {
      f.dispose();
      figure.current = null;
    };
  }, [make]);

  useEffect(() => {
    figure.current?.show(pose);
  }, [pose]);

  useEffect(() => {
    figure.current?.speaking(speaking);
  }, [speaking]);

  return <div ref={box} className="hr-figure" aria-hidden="true" data-pose={pose} />;
}
