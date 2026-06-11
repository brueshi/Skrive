Category 1: Webview-fundamental ceilings
These are the only entries that count as evidence for the Zig rebuild. Everything else goes in a different file.
A category 1 issue meets all four of these tests:
1. The cause is the webview, not your code.
You profiled it. The bottleneck traces to webview composition, JavaScript execution overhead, the IPC boundary between your Rust core and the editor surface, browser-engine layout, or CodeMirror's internal model. Not to your component tree, not to a query you wrote inefficiently, not to a missing memo, not to a Svelte reactivity bug. If you haven't profiled, it's not a category 1 entry yet. It's a suspicion.
2. The fix is not available inside the substrate.
You looked for the Tauri-side fix. There is no plugin, no API, no escape hatch, no configuration. CodeMirror does not expose the hook. Svelte does not have the primitive. The webview does not let you reach the layer where the problem lives. If a fix exists and you just don't want to use it, that goes in a different file.
3. The fix is available in a native substrate.
You can describe, concretely, how the same problem disappears or becomes tractable when the editor surface is a native text view talking directly to your Rust core. Not "it would probably be faster." Specifically: "CoreText handles this layout case in its shaper. DirectWrite has a primitive for this. A GPU-rendered text surface composites this in the same frame as the rest of the UI." If you can't name the native mechanism, you're guessing, and the entry is not category 1 yet.
4. The cost is measurable in shipped behavior.
The problem caused you to ship a feature worse than you wanted, defer a feature you'd otherwise build, or accept a quality compromise visible to users. "I had to cap the file size at 5MB or scroll jank becomes unacceptable." "The inline preview decoration spec was reduced because CodeMirror's decoration model can't express the typography." "The diff view took 400ms to render on a 500-block document and 100ms is achievable natively." A feeling of friction is not a cost. A deferred feature with a one-line description of what you would have built is a cost.
The smell test, separately.
If after writing the entry you read it back and it sounds like "the webview is not mine and that bothers me," it's not category 1. That sentence is true and is already settled — it goes in the case-for-Zig document, which you maintain separately. The ledger is for the things you didn't already know on day one.
What category 1 entries look like in practice
Format each entry like this:
markdown## YYYY-MM-DD — One-line problem statement

**What broke.** One paragraph. Specific. Includes the file or feature
involved, the size of the document or the shape of the input, the
behavior the user sees.

**What I tried.** What you measured, what you profiled, what tools you
reached for, what you read in the Tauri or CodeMirror or Svelte source.
Bullet list is fine. The bar: someone reading this in six months should
believe you actually attempted the substrate-side fix.

**Where it traces.** Webview composition / JS execution / IPC boundary /
CodeMirror model / Svelte reactivity / browser layout. Be specific.
Include profiler output filenames or screenshots if you have them.

**Native fix.** What concretely solves it on the other side. Name the
API or the rendering technique. If you can't, mark this **unconfirmed**
and come back to it.

**Shipped cost.** What feature got deferred, what spec got reduced,
what quality bar got lowered. One sentence.
What does not go in this file
A separate file, tauri-friction.md, holds category 2 entries. Native menu APIs missing. File dialog quirks. Keyboard handling that needs a plugin. Things that are real but solvable inside Tauri with effort. These are real engineering work but they are not evidence for a rebuild — they're evidence for a contribution to Tauri or a plugin you write.
A separate file, case-for-zig.md, holds the aesthetic and philosophical case. Webview is not yours. CodeMirror is JavaScript. Svelte is a foreign object. These are true and unchanging. The case-for-Zig document is the one you re-read when the apathy hits the Zig project. It does not need evidence — it is the position you are choosing. The ledger exists alongside it, not inside it.

