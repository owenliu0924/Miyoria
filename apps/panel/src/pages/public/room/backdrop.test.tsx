import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Backdrop, lightAt } from "./Backdrop";

describe("the room's backdrop", () => {
  it("takes the light of the member's hour", () => {
    expect([4, 5, 7, 8, 15, 16, 18, 19, 23, 0].map(lightAt)).toEqual([
      "night",
      "dawn",
      "dawn",
      "day",
      "day",
      "dusk",
      "dusk",
      "night",
      "night",
      "night",
    ]);
  });

  it("draws its own wall when the owner set no picture", () => {
    const { container } = render(<Backdrop image={null} hour={() => 17} />);
    const box = container.querySelector(".hr-backdrop") as HTMLElement;
    expect(box.dataset.light).toBe("dusk");
    expect(box.dataset.picture).toBeUndefined();
    expect(container.querySelector("img")).toBeNull();
    expect(box.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the owner's picture once it has loaded, and the wall again if it will not load", () => {
    const { container } = render(<Backdrop image="/api/member/room/backdrop/backdrop-0.webp" hour={() => 22} />);
    const img = container.querySelector("img.hr-picture") as HTMLImageElement;
    expect(img.dataset.shown).toBeUndefined();
    fireEvent.load(img);
    expect(img.dataset.shown).toBe("");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect((container.querySelector(".hr-backdrop") as HTMLElement).dataset.picture).toBeUndefined();
  });
});
