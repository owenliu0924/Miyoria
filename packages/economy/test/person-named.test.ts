// A name she uses for someone, turned into a person: the handle, the name at first sight, what
// she calls them, and the nickname they go by now (a server nickname changed since first sight).

import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { type HandleDirectory, HandleDirectoryKey, type HandleEntry } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { personNamed } from "../src/tools.js";

function directory(entries: HandleEntry[]): HandleDirectory {
  return {
    ofAccount: () => {
      throw new Error("not used");
    },
    ofPerson: (person) => entries.find((e) => e.person === person)?.handle ?? null,
    resolve: (handle) => entries.find((e) => e.handle === handle) ?? null,
    list: () => entries,
  } as HandleDirectory;
}

function entry(handle: string, person: string, first: string, names?: string[]): HandleEntry {
  return {
    handle,
    person,
    account: { platform: "discord", id: person },
    display_name: first,
    ...(names ? { names } : {}),
    created_at: "2026-11-01T00:00:00.000Z",
  };
}

function lookup(entries: HandleEntry[]) {
  const services = new ServiceRegistry();
  services.provide("test", HandleDirectoryKey, directory(entries));
  return (name: string) => personNamed(services, name);
}

describe("personNamed", () => {
  const find = lookup([
    entry("沒人", "p1", "沒人", ["GPT-6.2 Luna"]),
    entry("莎露朵", "p2", "莎露朵", ["DeepSeek V4.1 Flash 1121"]),
    entry("Alice", "p3", "Alice"),
  ]);

  it("finds someone by the nickname they changed to, as she reads it in the chat", () => {
    expect(find("GPT-6.2 Luna")).toBe("p1");
    expect(find("@gpt-6.2 luna")).toBe("p1");
    expect(find("DeepSeek V4.1 Flash 1121")).toBe("p2");
  });

  it("still finds them by the handle and by the name at first sight", () => {
    expect(find("沒人")).toBe("p1");
    expect(find("alice")).toBe("p3");
  });

  it("answers nobody for a part of a name, or a name two people go by", () => {
    expect(find("Luna")).toBeNull();
    const two = lookup([entry("A", "p1", "A", ["Same"]), entry("B", "p2", "B", ["same"])]);
    expect(two("Same")).toBeNull();
  });
});
