// Loading tool files: what a file may say, where secrets may appear, and how a folder is read.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpToolLoadError,
  HttpToolsConfigSchema,
  loadHttpTools,
  parseHttpTool,
} from "../../src/http-tools/index.js";

const config = HttpToolsConfigSchema.parse({ secrets: ["WEATHER_KEY"] });

const WEATHER = `
name = "weather_now"
description = "查某個城市現在的天氣"
risk = "low"
read_only = true
url = "https://api.example.com/v1/weather/{city}"
[params.city]
type = "string"
description = "城市名稱"
enum = ["Taipei", "Tokyo"]
[params.days]
type = "integer"
[query]
units = "metric"
[headers]
Authorization = "Bearer {secret:WEATHER_KEY}"
[response]
pick = ["main.temp", "weather.0.description"]
[limits]
per_person_per_hour = 30
`;

const refused = (text: string, match: RegExp) => {
  expect(() => parseHttpTool(text, config)).toThrow(HttpToolLoadError);
  expect(() => parseHttpTool(text, config)).toThrow(match);
};

describe("parseHttpTool", () => {
  it("reads a full file and settles where each parameter goes", () => {
    const def = parseHttpTool(WEATHER, config, "w.toml", "config");
    expect(def).toMatchObject({
      name: "weather_now",
      risk: "low",
      read_only: true,
      method: "GET",
      query: { units: "metric" },
      secrets: ["WEATHER_KEY"],
      response: {
        format: "json",
        pick: ["main.temp", "weather.0.description"],
        single: false,
        max_chars: 4000,
      },
      limits: { per_person_per_hour: 30 },
      file: "w.toml",
      origin: "config",
    });
    // In the url: a path parameter, so always required.
    expect(def.params.city).toMatchObject({ in: "path", required: true });
    expect(def.params.days).toMatchObject({ in: "query", required: false });
    expect(def.work).toBeUndefined();
  });

  it("defaults: medium risk, GET, json in and out, body parameters for POST", () => {
    const def = parseHttpTool(
      'name = "note"\ndescription = "x"\nmethod = "POST"\nurl = "https://api.example.com/n"\n[params.text]\ntype = "string"\n',
      config,
    );
    expect(def.risk).toBe("medium");
    expect(def.body.format).toBe("json");
    expect(def.params.text?.in).toBe("body");
    expect(def.response.pick).toBeNull();
  });

  it("refuses unknown keys anywhere", () => {
    refused(`${WEATHER}\nheader = "x"\n`, /header/);
    refused(WEATHER.replace("per_person_per_hour", "per_persn_per_hour"), /limits/);
    refused(WEATHER.replace('type = "integer"', 'type = "integer"\nrequird = true'), /params/);
  });

  it("refuses a secret outside [headers] values", () => {
    refused(WEATHER.replace("{city}", "{city}?k={secret:WEATHER_KEY}"), /secret/);
    refused(WEATHER.replace('units = "metric"', 'units = "{secret:WEATHER_KEY}"'), /query/);
    refused(
      WEATHER.replace('description = "城市名稱"', 'description = "{ SECRET :WEATHER_KEY}"'),
      /secret/,
    );
    refused(`${WEATHER}\n[body]\nformat = "{secret:WEATHER_KEY}"\n`, /body/);
  });

  it("refuses a secret not listed in the config, and a malformed one", () => {
    refused(WEATHER.replace("{secret:WEATHER_KEY}", "{secret:HOME}"), /HOME.*not listed/);
    refused(WEATHER.replace("{secret:WEATHER_KEY}", "{secret: WEATHER_KEY"), /malformed/);
    refused(WEATHER.replace("{secret:WEATHER_KEY}", "{secret:BAD-NAME}"), /variable name/);
  });

  it("refuses placeholders that are not declared or that sit in the host", () => {
    refused(WEATHER.replace("{city}", "{town}"), /town/);
    refused(WEATHER.replace("api.example.com", "{city}.example.com"), /after the host/);
    refused(WEATHER.replace("{city}", "{city"), /brace/);
  });

  it("refuses urls the guard would refuse, and reserved headers", () => {
    refused(WEATHER.replace("https://api.example.com", "http://192.168.1.1"), /url refused/);
    refused(WEATHER.replace("https://api.example.com", "http://localhost:8080"), /url refused/);
    refused(WEATHER.replace("https://", "file://"), /http/);
    refused(WEATHER.replace("Authorization", "Host"), /transport/);
  });

  it("refuses a body parameter on GET and a path parameter that is not in the url", () => {
    refused(WEATHER.replace('type = "integer"', 'type = "integer"\nin = "body"'), /GET/);
    refused(WEATHER.replace('type = "integer"', 'type = "integer"\nin = "path"'), /no \{days\}/);
    refused(WEATHER.replace('enum = ["Taipei", "Tokyo"]', "enum = [1, 2]"), /enum/);
  });
});

describe("loadHttpTools", () => {
  const made: string[] = [];
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "http-tools-"));
    made.push(d);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
    return d;
  };
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads every *.toml directly in each folder; a missing folder has none", () => {
    const a = dir({
      "weather.toml": WEATHER,
      "notes.txt": "not a tool",
      "broken.toml": 'name = "x"\n',
    });
    mkdirSync(join(a, "sub"));
    writeFileSync(join(a, "sub", "deep.toml"), WEATHER.replace("weather_now", "deep"));
    const out = loadHttpTools(
      [
        { dir: a, origin: "config" },
        { dir: join(a, "missing"), origin: "ext:demo" },
      ],
      config,
    );
    expect(out.tools.map((t) => t.name)).toEqual(["weather_now"]);
    expect(out.tools[0]?.file).toBe(join(a, "weather.toml"));
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]?.file).toBe(join(a, "broken.toml"));
  });

  it("keeps the first of two tools with one name and records the other", () => {
    const a = dir({ "a.toml": WEATHER });
    const b = dir({ "b.toml": WEATHER });
    const out = loadHttpTools(
      [
        { dir: a, origin: "config" },
        { dir: b, origin: "ext:demo" },
      ],
      config,
    );
    expect(out.tools.map((t) => [t.name, t.origin])).toEqual([["weather_now", "config"]]);
    expect(out.problems[0]).toMatchObject({ file: join(b, "b.toml") });
    expect(out.problems[0]?.reason).toMatch(/already used/);
  });

  it("an extension's files use only the secrets the owner granted that extension", () => {
    const a = dir({ "weather.toml": WEATHER });
    const denied = loadHttpTools([{ dir: a, origin: "ext:demo", secrets: [] }], config);
    expect(denied.tools).toEqual([]);
    expect(denied.problems[0]?.reason).toMatch(/not granted to ext:demo/);
    const granted = loadHttpTools(
      [{ dir: a, origin: "ext:demo", secrets: ["WEATHER_KEY"] }],
      config,
    );
    expect(granted.tools.map((t) => t.name)).toEqual(["weather_now"]);
    // Granted to the extension is not enough without the owner's `[modules.http_tools] secrets`.
    const unlisted = loadHttpTools(
      [{ dir: a, origin: "ext:demo", secrets: ["WEATHER_KEY"] }],
      HttpToolsConfigSchema.parse({}),
    );
    expect(unlisted.problems[0]?.reason).toMatch(/not listed in \[modules.http_tools\] secrets/);
  });

  it("never puts a key pasted into a file in a problem", () => {
    const key = "sk-abcdefghijklmnopqrstuvwx1234";
    const a = dir({
      "bad.toml": `name = "x"\ndescription = "y"\nurl = "https://a.example.com/"\n${key}\n`,
    });
    const out = loadHttpTools([{ dir: a, origin: "config" }], config);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0]?.reason).not.toContain(key);
  });
});
