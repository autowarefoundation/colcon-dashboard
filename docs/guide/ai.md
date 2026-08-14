---
icon: lucide/sparkles
description: >-
  One click starts a headless claude run on a failed package and streams the
  investigation live. Nothing runs by itself, and the transcript persists.
---

# AI failure analysis

When the [claude CLI](https://claude.com/claude-code) is installed, the pane of a failed package shows an **✦ ask claude** button. It starts a headless `claude` run in the workspace, with the tail of the failed log as the prompt. A new ✦ pane streams the investigation live: the files it reads, the commands it runs, and the answer.

<!-- TODO(images): an analysis pane streaming an investigation. -->

- Nothing runs by itself. Each analysis starts with a click, and it spends your Claude usage.
- The run gets read tools approved and no edit tools. Headless claude refuses actions that need more permission.
- The transcript persists next to the logs of the package, so it survives a server restart and reopens instantly.
- The input box under the transcript asks follow-up questions in the same session, through `claude --resume`.
