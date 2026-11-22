// What a failure says, and to whom: anyone out there gets no internal error text.

import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { toResponse } from "../src/server.js";

async function said(response: Response): Promise<{ status: number; error: string }> {
  const body = (await response.json()) as { error: string };
  return { status: response.status, error: body.error };
}

describe("an error's answer", () => {
  const boom = new Error("ECONNREFUSED 10.0.0.5:8005");

  it("tells an admin route what went wrong", async () => {
    expect(await said(toResponse(boom))).toEqual({ status: 500, error: boom.message });
    expect(await said(toResponse(ApiError.badGateway(boom)))).toEqual({
      status: 502,
      error: boom.message,
    });
  });

  it("keeps it from anyone out there", async () => {
    const hidden = { error: "something went wrong" };
    expect(await said(toResponse(boom, true))).toEqual({ status: 500, ...hidden });
    expect(await said(toResponse(ApiError.internal(boom), true))).toEqual({
      status: 500,
      ...hidden,
    });
    expect(await said(toResponse(ApiError.badGateway(boom), true))).toEqual({
      status: 502,
      ...hidden,
    });
  });

  it("still says what a caller did wrong, which is written for them", async () => {
    expect(await said(toResponse(ApiError.notFound("no such card"), true))).toEqual({
      status: 404,
      error: "no such card",
    });
    expect(await said(toResponse(ApiError.unavailable("not available right now"), true))).toEqual({
      status: 503,
      error: "not available right now",
    });
  });
});
