import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "./worker";

type Frame = Record<string, unknown>;
type Received = Frame | "audio";

let instanceCounter = 0;

function speculativePath() {
  return `/agents/test-speculative-voice-agent/speculative-${++instanceCounter}`;
}

function eagerIgnoredPath() {
  return `/agents/test-eager-ignored-voice-agent/ignored-${++instanceCounter}`;
}

async function connect(path: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://example.com${path}`, {
      headers: { Upgrade: "websocket" }
    }),
    env,
    ctx
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const frames: Received[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    frames.push(typeof e.data === "string" ? JSON.parse(e.data) : "audio");
  });
  return { ws, frames };
}

function send(ws: WebSocket, msg: Frame) {
  ws.send(JSON.stringify(msg));
}

function waitFor(
  ws: WebSocket,
  predicate: (msg: Frame) => boolean,
  timeout = 5000
): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for frame")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data) as Frame;
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(msg);
    };
    ws.addEventListener("message", handler);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function command(ws: WebSocket, msg: Frame) {
  const ack = waitFor(ws, (m) => m.type === "_ack" && m.command === msg.type);
  send(ws, msg);
  await ack;
}

async function startCall(ws: WebSocket) {
  const listening = waitFor(
    ws,
    (m) => m.type === "status" && m.status === "listening"
  );
  send(ws, { type: "start_call" });
  await listening;
}

async function speculation(ws: WebSocket) {
  const result = waitFor(ws, (m) => m.type === "_speculation");
  send(ws, { type: "_get_speculation" });
  return (await result) as {
    turns: Array<{ transcript: string; speculative: boolean }>;
    confirmations: boolean[];
    toolRuns: string[];
    messages: Array<{ role: string; text: string }>;
  };
}

function replyFrames(frames: Received[]) {
  return frames.filter(
    (f) =>
      f === "audio" ||
      (f.type === "transcript" && f.role === "user") ||
      f.type === "transcript_start" ||
      f.type === "transcript_end" ||
      (f.type === "status" &&
        (f.status === "thinking" || f.status === "speaking"))
  );
}

function assistantEnd(ws: WebSocket) {
  return waitFor(ws, (m) => m.type === "transcript_end");
}

describe("VoiceAgent — speculative turns", () => {
  it("prepares the reply on an eager end of turn and holds it until the turn is confirmed", async () => {
    const { ws, frames } = await connect(speculativePath());
    await startCall(ws);

    await command(ws, { type: "_eager", text: "what time is it" });
    await sleep(150);
    expect(replyFrames(frames)).toEqual([]);

    const end = assistantEnd(ws);
    const metrics = waitFor(ws, (m) => m.type === "turn_metrics");
    await command(ws, { type: "_final", text: "What time is it" });
    expect((await end).text).toBe("Echo: what time is it");
    expect(frames).toContain("audio");

    const summary = await metrics;
    expect(summary.outcome).toBe("completed");
    expect(summary.finalInputToFirstAudioMs).toBe(0);
    expect(summary.speculativeLeadMs).toBeGreaterThanOrEqual(100);

    const state = await speculation(ws);
    expect(state.turns).toEqual([
      { transcript: "what time is it", speculative: true }
    ]);
    expect(state.confirmations).toEqual([true]);
    expect(state.toolRuns).toEqual(["what time is it"]);
    expect(state.messages).toEqual([
      { role: "user", text: "what time is it" },
      { role: "assistant", text: "Echo: what time is it" }
    ]);
    ws.close();
  });

  it("drops the held reply when the user keeps talking, and never runs its side effects", async () => {
    const { ws, frames } = await connect(speculativePath());
    await startCall(ws);

    await command(ws, { type: "_eager", text: "set a timer" });
    await sleep(100);
    await command(ws, { type: "_resumed" });

    const end = assistantEnd(ws);
    await command(ws, { type: "_final", text: "set a timer for ten minutes" });
    expect((await end).text).toBe("Echo: set a timer for ten minutes");

    const said = frames
      .filter((f): f is Frame => f !== "audio")
      .map((f) => f.text)
      .filter((text) => typeof text === "string");
    expect(said).not.toContain("set a timer");
    expect(said).not.toContain("Echo: set a timer");

    const state = await speculation(ws);
    expect(state.turns).toEqual([
      { transcript: "set a timer", speculative: true },
      { transcript: "set a timer for ten minutes", speculative: false }
    ]);
    expect(state.confirmations).toEqual([false, true]);
    expect(state.toolRuns).toEqual(["set a timer for ten minutes"]);
    expect(state.messages).toEqual([
      { role: "user", text: "set a timer for ten minutes" },
      { role: "assistant", text: "Echo: set a timer for ten minutes" }
    ]);
    ws.close();
  });

  it("starts over when the final transcript differs from the eager one", async () => {
    const { ws } = await connect(speculativePath());
    await startCall(ws);

    await command(ws, { type: "_eager", text: "play some jazz" });
    const end = assistantEnd(ws);
    await command(ws, { type: "_final", text: "play some jazz piano" });
    expect((await end).text).toBe("Echo: play some jazz piano");

    const state = await speculation(ws);
    expect(state.confirmations).toEqual([false, true]);
    expect(state.toolRuns).toEqual(["play some jazz piano"]);
    ws.close();
  });

  it("drops the held reply when new speech starts", async () => {
    const { ws, frames } = await connect(speculativePath());
    await startCall(ws);

    await command(ws, { type: "_eager", text: "hello" });
    await command(ws, { type: "_speech_start" });
    await sleep(150);
    expect(replyFrames(frames)).toEqual([]);

    const state = await speculation(ws);
    expect(state.confirmations).toEqual([false]);
    expect(state.toolRuns).toEqual([]);
    expect(state.messages).toEqual([]);
    ws.close();
  });

  it("streams live once confirmed while onTurn is still running", async () => {
    const { ws } = await connect(speculativePath());
    await startCall(ws);

    await command(ws, { type: "_set_turn_delay", value: 200 });
    await command(ws, { type: "_eager", text: "tell me a story" });
    const end = assistantEnd(ws);
    await command(ws, { type: "_final", text: "tell me a story" });
    expect((await end).text).toBe("Echo: tell me a story");

    const state = await speculation(ws);
    expect(state.turns).toHaveLength(1);
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    ws.close();
  });

  it("ignores eager predictions unless speculativeTurns is enabled", async () => {
    const { ws } = await connect(eagerIgnoredPath());
    await startCall(ws);

    await command(ws, { type: "_eager", text: "hi there" });
    await sleep(100);
    const end = assistantEnd(ws);
    await command(ws, { type: "_final", text: "hi there" });
    expect((await end).text).toBe("Echo: hi there");

    const state = await speculation(ws);
    expect(state.turns).toEqual([
      { transcript: "hi there", speculative: false }
    ]);
    ws.close();
  });
});
