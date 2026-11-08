---
icon: lucide/circle-alert
description: >-
  What the dashboard does when a package fails: the log opens by itself, the
  Failures tab collects every error, the graph shows the blocked packages,
  and Claude can look for the cause.
---

# When a build fails

A failed package in a long build is easy to miss in a terminal. The dashboard brings it to you.

![A failed build of ros2/examples: the failed package in red, and the Failures tab with its compiler error](../assets/screens/failure-light.webp#only-light)
![A failed build of ros2/examples, dark theme](../assets/screens/failure-dark.webp#only-dark)

## The moment a package fails

- The log pane of the package opens by itself, and a notice points to it.
- If notifications are on, you get a desktop notification for the first failed package.
- The package turns red in the graph and in the timeline. Every package that depends on it gets a red dashed border, because it can no longer build. Packages that were only stopped stay gray.
- The browser tab shows ✗.

A page that you open on a failed build also opens the logs of the failed packages, the first failure first.

## The Failures tab

A **Failures** tab appears in the dock with the first failure. It collects every failed package of the build, in the order in which they failed. For each package, it shows the last lines of its error output, a link to the line in the log, an **Open log** button, and an **Ask Claude** button. When a failed build ends, this tab comes to the front.

![The Failures tab: the failed package, the command that failed, and the end of its error output](../assets/screens/failures-tab-light.webp#only-light)
![The Failures tab, dark theme](../assets/screens/failures-tab-dark.webp#only-dark)

## Find the error in the log

- Errors have a red bar and a red tint. The red marks beside the scrollbar show where they are. Click a mark to jump to it.
- A compiler error shows the file position underlined. With an [editor link](../configuration.md#editor-links), a click opens the file at that line in your editor.
- Click **Failed** above the graph to see every package that the failure blocks.

## Ask Claude

If the [claude CLI](https://claude.com/claude-code) is installed, the log of a failed package has an **Ask Claude** button. Claude reads the error and the code of your workspace, and it explains the cause. See [Ask Claude](ai.md).

## Build again

Fix the error and run `colcon build` again. The page switches to the new build by itself. To build only what failed, use colcon's own option:

```bash
colcon build --packages-select-build-failed
```

The [build picker](index.md#build-picker) keeps the failed build, so you can compare the two.
