// Wordle tools. She starts a game, guesses five-letter words one at a time and reads the marks back.
// Everything runs in this process: the answer never reaches her until the game ends or she gives up.
// One game per channel, so two channels (or a text channel and the voice call) don't mix.

import { readFileSync } from "node:fs";
import { defineExtension } from "@miyoria/sdk";
import { type Dictionary, Game } from "./game.js";

interface WordleConfig {
  max_guesses?: number;
}

function wordsFrom(file: string): string[] {
  return readFileSync(new URL(`../words/${file}`, import.meta.url), "utf8")
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^[a-z]{5}$/.test(w));
}

export function loadDictionary(): Dictionary {
  const answers = wordsFrom("answers.txt");
  return { answers, allowed: new Set([...answers, ...wordsFrom("guesses.txt")]) };
}

export default defineExtension({
  async activate(ctx) {
    const config = ctx.config as WordleConfig;
    const maxGuesses = Math.min(12, Math.max(1, Math.trunc(config.max_guesses ?? 6)));
    const dictionary = loadDictionary();
    const games = new Map<string, Game>();

    const keyOf = (c: { platform: string; scope: string | null; channel: string }) =>
      `${c.platform}:${c.scope ?? ""}:${c.channel}`;

    await ctx.tools.register({
      name: "wordle.start",
      description:
        "開一局 Wordle:電腦想一個五個字母的英文單字,她最多猜幾次(預設 6 次)。這個頻道已經有一局正在玩就不會重開,先 wordle.status 看進度,真的要換用 wordle.give_up。",
      run: (_args, call) => {
        const key = keyOf(call.context);
        const current = games.get(key);
        if (current && !current.finished) return `這個頻道已經有一局在玩了。\n${current.board()}`;
        const answer = dictionary.answers[Math.floor(Math.random() * dictionary.answers.length)]!;
        games.set(key, new Game(answer, maxGuesses, dictionary));
        return `新的一局開始:五個字母的英文單字,最多猜 ${maxGuesses} 次。🟩 字母和位置都對、🟨 有這個字母但位置不對、⬛ 沒有。用 wordle.guess 猜。`;
      },
    });

    await ctx.tools.register({
      name: "wordle.guess",
      description:
        "猜一個五個字母的英文單字,回傳每個字母的提示(🟩 位置對、🟨 有但位置不對、⬛ 沒有)和剩下的次數。不是單字、已經猜過或長度不對時不算次數。",
      params: { word: { type: "string", description: "五個英文字母,不分大小寫" } },
      run: ({ word }, call) => {
        const game = games.get(keyOf(call.context));
        if (!game) return "還沒開局,先用 wordle.start";
        const r = game.guess(String(word ?? ""));
        if (!r.ok) return `失敗:${r.reason}`;
        if (r.won) return `${r.line}\n答對了!用了 ${game.guesses.length}/${game.maxGuesses} 次。`;
        if (r.lost) return `${r.line}\n次數用完了,沒猜到。答案是 ${game.giveUp()}。`;
        return `${r.line}\n${game.board()}`;
      },
    });

    await ctx.tools.register({
      name: "wordle.status",
      description:
        "看這個頻道目前這局 Wordle:猜過的字和提示、剩幾次、字母表上哪些確定有、哪些確定沒有。",
      run: (_args, call) => {
        const game = games.get(keyOf(call.context));
        if (!game) return "這個頻道還沒開局";
        return `${game.finished ? "(這局已結束)\n" : ""}${game.board()}`;
      },
    });

    await ctx.tools.register({
      name: "wordle.give_up",
      description: "放棄這局 Wordle 並公布答案。只在她真的想不出來、或要換一局的時候用。",
      run: (_args, call) => {
        const game = games.get(keyOf(call.context));
        if (!game || game.finished) return "這個頻道沒有正在玩的一局";
        return `放棄了。答案是 ${game.giveUp()}。`;
      },
    });

    ctx.log.info("wordle extension activated", {
      answers: dictionary.answers.length,
      allowed: dictionary.allowed.size,
      max_guesses: maxGuesses,
    });
  },
});
