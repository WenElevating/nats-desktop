import { it, expect, vi, beforeEach, afterEach } from "vitest";

type FakeWS = {
  url: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  close: () => void;
  sentClose: boolean;
};

let sockets: FakeWS[];
let WS: typeof WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  WS = class {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    sentClose = false;
    constructor(url: string) {
      this.url = url;
      sockets.push(this as unknown as FakeWS);
    }
    close() {
      this.sentClose = true;
      this.onclose?.();
    }
  } as unknown as typeof WebSocket;
  vi.stubGlobal("WebSocket", WS);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import { connectMsgChannel } from "../src/lib/msgChannel";

it("connects with the token in the query string and routes parsed frames", () => {
  const seen: unknown[] = [];
  connectMsgChannel("ws://127.0.0.1:1/messaging/data", "tok", (d) => seen.push(d));
  expect(sockets[0].url).toBe("ws://127.0.0.1:1/messaging/data?token=tok");
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: JSON.stringify([{ seq: 1 }]) });
  expect(seen).toEqual([[{ seq: 1 }]]);
});

it("reconnects with capped backoff and resets on open", () => {
  connectMsgChannel("ws://x", "t", () => {});
  sockets[0].onclose?.(); // attempt 0 → +1s
  vi.advanceTimersByTime(999);
  expect(sockets.length).toBe(1);
  vi.advanceTimersByTime(1);
  expect(sockets.length).toBe(2);
  sockets[1].onclose?.(); // attempt 1 → +2s
  vi.advanceTimersByTime(2000);
  expect(sockets.length).toBe(3);
  sockets[2].onopen?.(); // reset
  sockets[2].onclose?.(); // attempt reset → +1s
  vi.advanceTimersByTime(1000);
  expect(sockets.length).toBe(4);
});

it("close() stops reconnects and closes the socket", () => {
  const ch = connectMsgChannel("ws://x", "t", () => {});
  ch.close();
  vi.advanceTimersByTime(60000);
  expect(sockets.length).toBe(1);
  expect(sockets[0].sentClose).toBe(true);
});

it("bad frames are logged, not thrown", () => {
  const log = vi.fn();
  const seen: unknown[] = [];
  connectMsgChannel("ws://x", "t", (d) => seen.push(d), log);
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: "not-json" });
  expect(seen).toEqual([]);
  expect(log).toHaveBeenCalled();
});
