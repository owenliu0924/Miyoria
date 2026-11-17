import "./style.css";
import { mountBackdrop } from "./backdrop.js";
import { parseConfig } from "./config.js";
import { connectFeed } from "./connection.js";
import { startDemo } from "./demo.js";
import { Overlay } from "./view.js";
import { startWordleDemo } from "./wordle-demo.js";
import { WordlePage } from "./wordle-page.js";

const cfg = parseConfig(window.location.search, window.location);
document.documentElement.style.setProperty("--scale", String(cfg.scale));
document.documentElement.dataset.layout = cfg.layout;

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing");

if (cfg.layer === "backdrop") {
  // A still page: no feed, no frame loop.
  mountBackdrop(root, cfg.layout);
} else if (cfg.layer === "wordle") {
  // Her Wordle game: only the feed's boards matter here.
  const page = new WordlePage(root);
  if (cfg.demo) startWordleDemo((board) => page.update(board));
  else {
    connectFeed({
      url: cfg.ws,
      onMessage: (m) => {
        if (m.type === "wordle") page.update(m.board);
      },
      onConnection: (connected) => {
        if (!connected) page.update(null);
      },
    });
  }
} else {
  const overlay = new Overlay(root, cfg);

  if (cfg.demo) {
    overlay.dispatch({ type: "connection", connected: true });
    startDemo((m) => overlay.dispatch(m));
  } else {
    connectFeed({
      url: cfg.ws,
      onMessage: (m) => overlay.dispatch(m),
      onConnection: (connected) => overlay.dispatch({ type: "connection", connected }),
    });
  }

  const tick = (now: number): void => {
    overlay.frame(now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
