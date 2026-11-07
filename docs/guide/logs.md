---
icon: lucide/scroll-text
description: >-
  Per-package log panes with search, ANSI colors, timestamps, stream
  selection, editor links, and a failures tab that aggregates every failure.
---

# Log panes

The dock opens with a pinned **build log** tab: the whole build, as a terminal shows it, with `Starting >>>` and `Finished <<<` lines between the output of every package. Click any package in the graph or the timeline to open its own tab next to it. Each tab has its own scrollback, so logs never interleave.

![The failure summary: the failed package, the step and the command that failed, and the end of its log](../assets/screens/failures.webp)

- A pane follows new output until you scroll up. The **Follow** button re-engages.
- Panes open at the tail for an instant start. **Load all** fetches the whole history in one click.
- Every line carries a timestamp: build-relative in the build log, job-relative in package panes. The **Time** button hides them.
- The **Wrap** button soft-wraps long lines. The choice sticks for future panes. AI panes start wrapped, because prose reads badly on one line.
- The **search** box filters as you type, and matching lines highlight. ++enter++ and ++shift+enter++ step through the matches. The search stays live while the log streams.
- A selector switches a package pane between the timestamped output, `stdout+stderr`, `stderr`, `stdout`, and the command log.
- If a finished package has no timestamped output, the pane switches to `stdout+stderr` and says so. An empty pane always shows a note that tells why it is empty.
- The panes show ANSI colors as a terminal does: the 16 classic colors, 256-color, and truecolor, with palettes tuned per theme. Uncolored lines that match error or warning patterns still get color.
- If a package fails, its pane opens by itself and a toast points to it. A page that opens on an already failed build also opens the panes of the failed packages, earliest failure first.
- A **Failures** tab appears with the first failure, and it aggregates every failed package. It shows the last stderr lines of each, in failure order, with a jump link, an **Open log** button, and the **Ask Claude** button. When a failed build ends, this pane comes to the front.
- The **Path** button in a package pane copies the absolute source path of the package.
- If `editor_url` is [set](../configuration.md#editor-links), each `file:line` position in the logs gets a ↗ link that opens your editor at that line.
- **✕ close all** at the end of the tab strip closes every tab except the build log.
- Drag the bar above the dock to resize it.

The address bar mirrors the open pane and the picked view (`#pkg=...&view=...`), so a copied link opens the same package pane for a colleague. The `ws` and `build` query parameters already pin the workspace and the build.
