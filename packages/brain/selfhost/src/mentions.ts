// `@name` in her text lines, turned into the platform's mention markup for the people known in the
// place (`mention_users`). Applied to the text that is sent; the transcript keeps what she wrote.
// Role, `@everyone` and `@here` mentions never come out of here: only user mentions do.

export interface MentionTarget {
  /** Display name as she sees it in the transcript. */
  name: string;
  /** What `@name` becomes, e.g. `<@1234>` on Discord. */
  markup: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces `@name` (longest names first, not followed by a letter or digit) with the target's
 * markup. Names are matched exactly; anything else stays as written. Code (fenced or inline) is
 * left as it is.
 */
export function linkMentions(text: string, targets: readonly MentionTarget[]): string {
  const usable = targets
    .filter((t) => t.name.trim() !== "" && t.markup !== "")
    .sort((a, b) => [...b.name].length - [...a.name].length);
  if (usable.length === 0 || !text.includes("@")) return text;
  const byName = new Map(usable.map((t) => [t.name, t.markup]));
  const pattern = new RegExp(
    `@(${usable.map((t) => escapeRegExp(t.name)).join("|")})(?![\\p{L}\\p{N}_])`,
    "gu",
  );
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/u)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(pattern, (whole, name: string) => byName.get(name) ?? whole),
    )
    .join("");
}
