// The types extension authors import are derived from the contract now. Each one must still
// accept what the hand-written one accepted and give back what it gave: every name is held to
// its old shape (`previous-types.ts`, verbatim) in both directions, at compile time. The runtime
// part checks that the constants did not move.

import { describe, expect, expectTypeOf, it } from "vitest";
import type * as Old from "./previous-types.js";
import { ErrorCode, PROTOCOL_VERSION } from "../src/types.js";
import type * as Now from "../src/types.js";
import type * as OldTask from "./previous-task.js";
import type * as NowTask from "../src/task.js";

/** Mutual assignability: neither side gained or lost anything an author could notice. */
function same<A, B>(..._check: [A] extends [B] ? ([B] extends [A] ? [] : [never]) : [never]): void {}

describe("types derived from the contract keep their shapes", () => {
  it("the protocol types", () => {
    same<Now.Ulid, Old.Ulid>();
    same<Now.Timestamp, Old.Timestamp>();
    same<Now.AccountRef, Old.AccountRef>();
    same<Now.ContextKind, Old.ContextKind>();
    same<Now.ContextKey, Old.ContextKey>();
    same<Now.MessageRef, Old.MessageRef>();
    same<Now.Author, Old.Author>();
    same<Now.Priority, Old.Priority>();
    same<Now.ModuleStateKind, Old.ModuleStateKind>();
    same<Now.DecisionTrace, Old.DecisionTrace>();
    same<Now.PlaybackState, Old.PlaybackState>();
    same<Now.Participant, Old.Participant>();
    same<Now.PromptRequest, Old.PromptRequest>();
    same<Now.PromptSection, Old.PromptSection>();
    same<Now.JsonSchema, Old.JsonSchema>();
    same<Now.ToolDecl, Old.ToolDecl>();
    same<Now.ToolCallContext, Old.ToolCallContext>();
    same<Now.ArgKind, Old.ArgKind>();
    same<Now.ArgSpec, Old.ArgSpec>();
    same<Now.CommandSpec, Old.CommandSpec>();
    same<Now.ArgValue, Old.ArgValue>();
    same<Now.ResolvedUser, Old.ResolvedUser>();
    same<Now.Invocation, Old.Invocation>();
    same<Now.CommandReply, Old.CommandReply>();
    same<Now.Permissions, Old.Permissions>();
    same<Now.InitializeParams, Old.InitializeParams>();
    same<Now.Contributions, Old.Contributions>();
    same<Now.ExecutorDecl, Old.ExecutorDecl>();
    same<Now.InitializeResult, Old.InitializeResult>();
    same<Now.RpcErrorObject, Old.RpcErrorObject>();
    expectTypeOf<Now.Event["type"]>().toEqualTypeOf<Old.Event["type"]>();
    same<Now.Envelope["event"], Old.Envelope["event"]>();
    same<Omit<Now.Envelope, "event">, Omit<Old.Envelope, "event">>();
  });

  it("the types that grew optional fields still take the old values", () => {
    // These gained optional fields the platform really sends (`reply_to`, `stickers`, `turn`,
    // an attachment's `id`): a value built the old way is still one, and one read the new way is
    // still an old one.
    expectTypeOf<Old.IncomingMessage>().toExtend<Now.IncomingMessage>();
    expectTypeOf<Now.IncomingMessage>().toExtend<Old.IncomingMessage>();
    // `RpcMessage`: the result variant had a required `result` key (of type `unknown`); it is
    // optional now, since `unknown` cannot say "present" in a schema. Only read, never built.
    expectTypeOf<Old.RpcMessage>().toExtend<Now.RpcMessage>();
    expectTypeOf<Old.Attachment>().toExtend<Now.Attachment>();
    expectTypeOf<Old.VoiceUtterance>().toExtend<Now.VoiceUtterance>();
    expectTypeOf<Old.VoiceParticipant>().toExtend<Now.VoiceParticipant>();
  });

  it("the task types", () => {
    same<NowTask.TaskId, OldTask.TaskId>();
    same<NowTask.TaskSpec, OldTask.TaskSpec>();
    same<NowTask.TaskFailureCode, OldTask.TaskFailureCode>();
    same<NowTask.SteerOutcome, OldTask.SteerOutcome>();
    same<NowTask.TaskSteer, OldTask.TaskSteer>();
    same<NowTask.TaskEvent, OldTask.TaskEvent>();
    same<NowTask.TaskEventType, OldTask.TaskEventType>();
    same<NowTask.StructuredState, OldTask.StructuredState>();
  });

  it("the constants", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(ErrorCode).toEqual({
      ParseError: -32700,
      InvalidRequest: -32600,
      MethodNotFound: -32601,
      InvalidParams: -32602,
      InternalError: -32603,
      PermissionDenied: -32001,
      Timeout: -32002,
      Conflict: -32003,
      Unavailable: -32004,
      Closed: -32005,
      Cancelled: -32800,
    });
  });
});
