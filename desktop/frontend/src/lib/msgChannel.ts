// Data-plane channel for session message batches (m6-perf §12.3): delivering
// §7.1.3 batches through the wails event pipeline grows the WebView2 browser
// process ~231MB/h under sustained delivery, so batches ride a loopback
// WebSocket instead. Control events (session:state, errors) stay on wails
// events. Reconnect backoff 1s→8s capped; a close is final (no reconnect).

export interface MsgChannel {
  close(): void;
}

export function connectMsgChannel(
  url: string,
  token: string,
  onData: (data: unknown) => void,
  log: (...a: unknown[]) => void = console.error,
): MsgChannel {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    const sock = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
    };
    sock.onmessage = (ev) => {
      try {
        onData(JSON.parse(ev.data as string));
      } catch (err) {
        log("msg channel: undecodable frame", err);
      }
    };
    sock.onclose = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      attempt += 1;
      timer = setTimeout(open, delay);
    };
    sock.onerror = () => sock.close();
  };
  open();

  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ws?.close();
      ws = null;
    },
  };
}
