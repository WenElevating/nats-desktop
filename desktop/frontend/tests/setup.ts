// jsdom lacks ResizeObserver, which cmdk (command palette) and some Radix
// primitives require at mount time. Stub it for the test environment.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

// jsdom does not implement scrolling; cmdk calls scrollIntoView on selection.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value() {},
  });
}
