# opencode-handoff

Create focused handoff prompts for continuing work in new sessions.

Inspired by Amp's handoff command - see their [post](https://ampcode.com/news/handoff) and [manual](https://ampcode.com/manual#handoff) about it.

## Features

- `/handoff <goal>` command that analyzes the conversation and generates a continuation prompt
- Attaches a small working set for the next task and lists secondary files with descriptions for reading later
- Opens an editable review dialog with per-file attachment controls and approximate token estimates
- `read_session` tool for retrieving full conversation transcripts from previous sessions when the handoff summary isn't sufficient

## Requirements

- [OpenCode](https://opencode.ai/) v2.1.2 or later (opencode-handoff v0.5.0 is the last release for OpenCode v1)

## Installation

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugins": ["opencode-handoff"]
}
```

Restart OpenCode and you're ready to go.

Optionally, pin to a specific version for stability:

```json
{
  "plugins": ["opencode-handoff@0.6.0"]
}
```

OpenCode fetches unpinned plugins from npm on each startup; pinned versions are cached and require a manual version bump to update.

## Usage

1. Have a conversation in OpenCode with some context
2. When ready to continue in a fresh session, type `/handoff <your goal>`
3. Review the summary and file choices. Use Ctrl+S to send from any section, or Enter from the summary. Esc cancels.
4. A new session starts with the summary, a file manifest, and the selected attachments. The TUI switches to it.

**Example:**

```
/handoff implement the user authentication feature we discussed
```

The AI analyzes the conversation, extracts key decisions and relevant files, generates a focused prompt, and opens it for review before starting a new session.

The AI selects files for the next task, usually attaching the implementation being changed and its closest tests. The suggested 3–5 attached files are guidance, not a quota or enforced limit. Secondary files appear in a described reading list without loading their contents.

### Reviewing files

The file list controls attachments independently of the summary. Typing an `@path` in the summary no longer attaches that file.

- The full-width file table sits below the summary and scrolls within its bounds as the list grows. Each row shows a **[x]** removal button, the filename, estimated content **Tokens**, and a **Contents** control. Descriptions are omitted from the review list but retained in the handoff's reading list.
- Press Tab or Ctrl+F, or click a file, to focus the table. Use Up and Down to select a file. Tab or Esc returns to the summary without losing edits.
- Click **Include** or **Omit** in the **Contents** column, or press Space or Enter on a selected row, to change whether the handoff sends that file's contents. Omitted contents leave the file in the reading list without loading it.
- Click a row's **[x]** button, press Ctrl+D, or click **remove**, to leave that file out of the handoff entirely. The button highlights on hover.
- Press Ctrl+A in the file table, or click **Attach file**, to open OpenCode's searchable selection dialog. Type to search project files, then select one to include its contents. Files already in the review are excluded from the results. Esc returns to the review without changing your choices or summary.
- Press Ctrl+L in the file table, or click **Exclude all file contents**, to send paths and reference notes without attaching any file contents.

Duplicate paths are combined. If their modes differ, attach takes precedence unless attachments are disabled in configuration. Missing, unreadable, or binary attachment candidates remain listed with an explanation instead of attaching their contents. Files are checked again when you send.

The estimate below the files shows **Prompt + file contents = total tokens** on one line. The prompt includes the summary, source-session reference, and file manifest. Each file row counts only its contents, so references show zero there. Estimates use approximately four characters per token, not a model-specific tokenizer. They exclude system instructions, tool definitions, and host message wrappers. Reference-only file contents are not read or counted. If an attachment cannot be estimated, the affected totals show **unavailable** rather than zero.

Review needs the terminal UI showing the source session. Otherwise, for example with `opencode run` or the desktop app, the handoff starts without review using the same file choices and configuration.

### Disabling attachments

To keep every file list-only, set `attachFiles` to `false`:

```json
{
  "plugins": [{ "package": "opencode-handoff", "options": { "attachFiles": false } }]
}
```

This option also applies when review is skipped. The dialog shows that attachments are disabled and does not allow promoting files to attachments. **Add file path** opens the same picker, but new files remain path-only.

To always skip review, set the `review` option to `false`:

```json
{
  "plugins": [{ "package": "opencode-handoff", "options": { "review": false } }]
}
```

### Reading Previous Session Transcripts

When you use `/handoff`, the generated prompt includes a session reference line:

```
Continuing work from session sess_01jxyz123. When you lack specific information you can use read_session to get it.
```

This gives the AI in the new session access to the `read_session` tool, which can fetch the full conversation transcript from the source session. If the handoff summary doesn't include something you need, just ask - the AI can look it up.

**Example:**

```
You: What were the specific error messages we saw earlier?
```

The AI will use `read_session` to retrieve details from the previous session that weren't included in the handoff summary.

## Contributing

Contributions are welcome! Here's how to set up for development:

```bash
git clone https://github.com/joshuadavidthomas/opencode-handoff
cd opencode-handoff
bun install
```

Then point your OpenCode config at the checkout:

```json
{
  "plugins": ["file:///path/to/opencode-handoff"]
}
```

## License

opencode-handoff is licensed under the MIT license. See the [`LICENSE`](LICENSE) file for more information.

---

opencode-handoff is not built by, or affiliated with, the OpenCode team.

OpenCode is ©2025 Anomaly.
