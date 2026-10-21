# opencode-handoff

Create focused handoff prompts for continuing work in new sessions.

Inspired by Amp's handoff command - see their [post](https://ampcode.com/news/handoff) and [manual](https://ampcode.com/manual#handoff) about it.

## Features

- `/handoff <goal>` command that analyzes the conversation and generates a continuation prompt
- Guides the AI to include relevant `@file` references so the next session starts with context loaded
- Starts a new session with the handoff prompt and attaches the referenced files
- `read_session` tool for retrieving full conversation transcripts from previous sessions when the handoff summary isn't sufficient

## Requirements

- [OpenCode](https://opencode.ai/) v2.0 or later (this plugin uses the V2 plugin API; v0.5.0 is the last release for OpenCode v1)

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
3. The AI analyzes the conversation, generates the handoff prompt, and starts a new session with it

> **Note (v0.6, OpenCode V2):** V2 plugins can no longer control the TUI, so the handoff session starts immediately with the prompt instead of opening an editable draft, and the referenced files are attached to the prompt through OpenCode's attachment API instead of `@file` text that the TUI resolves.

**Example:**

```
/handoff implement the user authentication feature we discussed
```

The AI analyzes the conversation, extracts key decisions and relevant files, generates a focused prompt, and starts a new session with it.

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

Then symlink the plugin to your OpenCode config:

```bash
mkdir -p ~/.config/opencode/plugin
ln -sf "$(pwd)/src/plugin.ts" ~/.config/opencode/plugin/handoff.ts
```

## License

opencode-handoff is licensed under the MIT license. See the [`LICENSE`](LICENSE) file for more information.

---

opencode-handoff is not built by, or affiliated with, the OpenCode team.

OpenCode is ©2025 Anomaly.
