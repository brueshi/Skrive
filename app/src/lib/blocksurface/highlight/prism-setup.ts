// Prism configuration that must exist BEFORE Prism initializes.
//
// On load Prism inspects its environment and, when there is no `document` but a
// worker message channel is available, registers its OWN `message` listener that
// treats every posted message as a `{ language, code }` highlight request. In our
// worker we own the channel and speak a different protocol, so that listener would
// fight ours. Prism reads `manual` and `disableWorkerMessageHandler` off a
// pre-existing global `Prism` object at init time — so we seed one here.
//
// ES module imports evaluate in source order, so importing THIS module before
// `prismjs` guarantees the config object is in place when Prism reads it. It has
// no dependencies of its own, so nothing can reorder ahead of it.

const g = globalThis as unknown as {
  Prism?: { manual?: boolean; disableWorkerMessageHandler?: boolean };
};

g.Prism = { manual: true, disableWorkerMessageHandler: true };

export {};
