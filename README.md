# opencode-handoff

Create focused handoff prompts for continuing work in new sessions.

Inspired by Amp's handoff command - see their [post](https://ampcode.com/news/handoff) and [manual](https://ampcode.com/manual#handoff) about it.

## Features

- `/handoff <goal>` command that analyzes the conversation and generates a continuation prompt
- Builds a file manifest — each file listed with a careful description of exactly what is in it — so the next session knows what to read before reading anything
- Attaches no file contents: the new session reads each listed file itself with tools, in the order it prefers
- Opens the handoff prompt in an editable review dialog, then starts a new session with it and the manifest
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
3. A review dialog opens with the handoff draft; edit it if needed and press Enter to send (Esc cancels)
4. A new session starts with the prompt and the file manifest, and the TUI switches to it

**Example:**

```
/handoff implement the user authentication feature we discussed
```

The AI analyzes the conversation, extracts key decisions and relevant files, generates a focused prompt, and opens it for review before starting a new session.

The handoff text carries a `## Files` manifest — each path with a description of its contents — and no file contents are attached: the new session reads each file itself with tools. There is no upper bound on the manifest; files are ordered by importance, and with more than 10 the most important 10 form the main manifest while the rest are listed separately as "other context". The manifest is part of the editable review text, so editing it changes what the new session is told to read. Review needs the terminal UI showing the source session; otherwise (for example with `opencode run` or the desktop app) the session starts without review.

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
