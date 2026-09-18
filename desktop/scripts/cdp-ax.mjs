// CDP Accessibility probe: is the renderer producing an AX tree at all?
const port = process.env.NATSDESKTOP_CDP_PORT || "9228";
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await new Promise((r) => { ws.onopen = r; });
await send("Accessibility.enable");
const ax = await send("Accessibility.getFullAXTree", {});
const nodes = ax.nodes || [];
console.log("AX nodes:", nodes.length);
const byRole = {};
for (const n of nodes) byRole[n.role?.value] = (byRole[n.role?.value] || 0) + 1;
console.log("roles:", JSON.stringify(byRole));
const named = nodes.filter((n) => n.name?.value).slice(0, 25);
for (const n of named) console.log("  " + n.role?.value + ": " + n.name?.value);
ws.close();
process.exit(0);
