# agent-diff-cursor

Show any coding agent's edits in Cursor as **inline diffs**: the same red and green hunks, the
same **Undo** / **Keep** buttons on each hunk, and the same **Undo File** / **Keep File** bar that
Cursor shows for its own agent. The agent can be OpenCode, Claude Code, a script, or anything
that can run a command.

It uses Cursor's own inline diff code, so the buttons, keyboard shortcuts (Ctrl+N, Ctrl+Shift+Y,
Ctrl+Enter), Ctrl+Z and "Review next file" all work as they do for Cursor's agent.

The npm package is `agent-diff-cursor`; the command it installs is `agent-diff`.

This is an independent tool. It is not made by, or affiliated with, Cursor or Anysphere.

## How it works

1. Before editing a file, the agent runs `agent-diff snapshot <file>`.
   This saves the file's current text.
2. The agent edits the file on disk.
3. The agent runs `agent-diff show <file>`.
   The open Cursor window shows the changes as inline diffs.

Cursor has no public way to add inline diffs, so `install` does two things:

- It adds a small piece of code to Cursor's `workbench.desktop.main.js` that passes diffs to
  Cursor's inline diff service. It also updates the file's checksum in `product.json` so
  Cursor does not report a corrupt install. The original files are backed up first.
- It installs a small extension (`local.agent-diff`). The extension listens on
  `127.0.0.1` with a random port and a secret token, so the command line can reach each
  open Cursor window.

## Install

Needs Node.js 18 or newer.

```powershell
npm install -g agent-diff-cursor
```

Close Cursor completely, then run:

```powershell
agent-diff install
```

Start Cursor again. Check that it worked:

```powershell
agent-diff status
```

Options:

- `--cursor <folder>` if Cursor is not in the default place
  (`%LOCALAPPDATA%\Programs\cursor` on Windows, `/Applications/Cursor.app` on macOS).
  You can also set `AGENT_DIFF_APP`.
- `--extensions-dir <folder>` if Cursor uses a different extensions folder.
- `--skip-extension` to only patch Cursor.

**After every Cursor update, run `install` again.** An update replaces the patched file.
`status` tells you when the patch is missing.

If Cursor starts without the patch, the extension shows a warning that says to run `install`.

To remove it: close Cursor and run `agent-diff uninstall`. It removes the patch and the extension.

## Commands

| Command | What it does |
|---|---|
| `snapshot <file>...` | Save the files as they are now. Run before editing. A missing file counts as a new file. |
| `show <file>... [--open]` | Show the changes since the snapshot in Cursor. `--open` also opens the file in a tab without taking focus. |
| `clear [<file>...]` | Stop showing this tool's diffs and forget the snapshots. No file means all of them. |
| `list` | List the inline diffs in each open Cursor window, marked "this tool" or "Cursor". |
| `status` | Show whether Cursor is patched and which windows are reachable. |

`snapshot`, `show` and `clear` never fail the agent. Problems are printed as warnings and the
exit code is 0. Add `--quiet` to print only warnings.

`snapshot` and `show` also take `--stdin`: they read an agent hook's JSON from stdin and use the
file path in it (the `file_path`, `filePath`, `path` or `notebook_path` field, inside
`tool_input` when there is one). Scripts can send a list instead:
`{"cwd": "...", "files": ["a.ts", "b.ts"]}`. Relative paths are taken from the JSON's `cwd`.
When a script runs the command through a shell, send file names this way, not as arguments,
so a file name can never be run as a command.

Files are matched to the Cursor window that has their folder open. Files larger than 5 MB and
binary files are skipped.

## Using it from an agent

Any agent with "before tool" and "after tool" hooks can call the two commands. Set it up for
one project, or once in your global agent settings for every project.

- **Claude Code:** add the hooks from
  [examples/claude-code/settings.json](examples/claude-code/settings.json) to
  `.claude/settings.json` in a project, or to `~/.claude/settings.json` for all projects:

  ```json
  {
    "hooks": {
      "PreToolUse": [
        { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
          "hooks": [{ "type": "command", "command": "agent-diff snapshot --stdin --quiet" }] },
        { "matcher": "Bash|PowerShell",
          "hooks": [{ "type": "command", "command": "agent-diff snapshot --git --stdin --quiet" }] }],
      "PostToolUse": [
        { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
          "hooks": [{ "type": "command", "command": "agent-diff show --stdin --quiet" }] },
        { "matcher": "Bash|PowerShell",
          "hooks": [{ "type": "command", "command": "agent-diff show --git --stdin --quiet" }] }],
      "PostToolUseFailure": [
        { "matcher": "Bash|PowerShell",
          "hooks": [{ "type": "command", "command": "agent-diff show --git --stdin --quiet" }] }]
    }
  }
  ```

- **OpenCode:** copy [examples/opencode/agent-diff.ts](examples/opencode/agent-diff.ts)
  to `.opencode/plugins/` in your project, or to `~/.config/opencode/plugins/` for all projects.
  It was written from OpenCode's plugin docs and has not been tested against a running OpenCode yet.
- **Anything else:** run `snapshot` on the files before the edit, and `show` on the same files
  after it.

### Changes made by shell commands

An agent can also change files by running a script or a command such as `sed`. A command doesn't
say which files it will change, so for commands the hooks use `--git` instead of file names:

- `agent-diff snapshot --git` before the command remembers which files git already sees as
  changed, and copies them.
- `agent-diff show --git` after the command asks git again and shows every file the command
  changed. For a file that was unchanged before, the text from before is git's saved copy.

This works in git repositories only. It doesn't see files that git ignores, or files outside the
repository. If two agents run commands in the same repository at the same time, a file one of
them changes can show up under the other one's command; it is still shown, just as part of the
other command.

Several edits in a row are fine. If a file still has a diff on screen, a new `snapshot` keeps the
first one, so the hunks cover all the edits. Hunks you already kept stay kept.

## How it behaves

Compared step by step with Cursor 3.29's own agent in a test copy of Cursor:

| Action | Cursor's agent | This tool |
|---|---|---|
| Hunks, buttons and file bar after an edit | Same | Same |
| **Undo** on one hunk | Changes the editor, does not save | Same |
| **Undo** on the last hunk, or **Undo File** | Restores the old text and saves | Same |
| Undo on a file the agent created | Deletes the file and closes its tab | Same |
| **Keep** / **Keep File** | Removes the hunks, does not save | Same |
| Ctrl+Z after **Keep** or **Keep File** | The hunks come back | Same |
| Ctrl+Z right after the edit | Puts the old text back in the editor (unsaved), hunks disappear | Same |
| Ctrl+Z after **Undo** or **Undo File** | The text comes back, but not as hunks | Same |
| Typing outside the hunks | Counts as kept, no new hunk | Same |
| A second edit to the same file | Merges into the hunks on screen | Same |
| Window reload | Hunks come back | Hunks are lost. Run `show` again to bring them back. |
| Cursor's agent window ("Agents" view) | No inline diffs | Same |

Cursor's own chat panel ("1 File · Undo · Keep · Review") only lists Cursor's agent edits, so
this tool's diffs do not appear there.

## Limits

- Cursor only. Tested with Cursor 3.29 on Windows. The patch looks for a few of Cursor's
  internal names and stops with a clear message if a Cursor version changed them.
- Patching Cursor's files is not supported by Cursor. If something looks wrong, run
  `uninstall` and restart Cursor.
- Snapshots are kept in `%LOCALAPPDATA%\agent-diff\snapshots` (macOS:
  `~/Library/Application Support/agent-diff`, Linux: `~/.local/state/agent-diff`). Only your user
  can open this folder.
  They are deleted after `show` finds no changes, after `clear`, or after 7 days.
  Set `AGENT_DIFF_HOME` to use another folder.

## Building from source

```powershell
npm install
npm run build
npm link
```

`npm link` puts the `agent-diff` command on your PATH from this folder.
