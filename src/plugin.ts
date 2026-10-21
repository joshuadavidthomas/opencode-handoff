import { Plugin } from "@opencode/plugin"
import { HandoffSession, ReadSession } from "./tools"
import { parseFileReferences, buildFileAttachments } from "./files"

const HANDOFF_COMMAND = `GOAL: You are creating a handoff message to continue work in a new session.

<context>
When an AI assistant starts a fresh session, it spends significant time exploring the codebase—grepping, reading files, searching—before it can begin actual work. This "file archaeology" is wasteful when the previous session already discovered what matters.

A good handoff frontloads everything the next session needs so it can start implementing immediately.
</context>

<instructions>
Analyze this conversation and extract what matters for continuing the work.

1. Identify all relevant files that should be loaded into the next session's context

   Include files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs. Be generous—the cost of an extra file is low; missing a critical one means another archaeology dig. Target 8-15 files, up to 20 for complex work.

2. Draft the context and goal description

   Describe what we're working on and provide whatever context helps continue the work. Structure it based on what fits the conversation—could be tasks, findings, a simple paragraph, or detailed steps.

   Preserve: decisions, constraints, user preferences, technical patterns.

   Exclude: conversation back-and-forth, dead ends, meta-commentary.

The user controls what context matters. If they mentioned something to preserve, include it—trust their judgment about their workflow.
</instructions>

<user_input>
This is what the next session should focus on. Use it to shape your handoff's direction—don't investigate or search, just incorporate the intent into your context and goals.

If empty, capture a natural continuation of the current conversation's direction.

USER: $ARGUMENTS
</user_input>

---

After generating the handoff message, IMMEDIATELY call handoff_session with your prompt and files:
\`handoff_session(prompt="...", files=["src/foo.ts", "src/bar.ts", ...])\``

export default Plugin.define({
  id: "handoff",
  async setup(ctx) {
    const processedSessions = new Set<string>()
    const abort = new AbortController()

    // Free the per-session dedupe entry once a session is deleted.
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === "session.deleted") {
          processedSessions.delete(event.data.sessionID)
        }
      }
    })()
    events.catch(() => {})

    // V2 plugin commands run server-side instead of inserting a template into
    // the TUI input, so the expanded template is submitted to the session
    // directly. The assistant then generates the handoff and calls
    // handoff_session, same as after V1's template was sent.
    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: "handoff",
        description: "Create a focused handoff prompt for a new session",
        execute: async ({ sessionID, prompt, delivery }) => {
          const text = HANDOFF_COMMAND.replace("$ARGUMENTS", prompt.text)
          await ctx.session.prompt({ sessionID, text, delivery })
        },
      })
    })

    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.add(HandoffSession(ctx))
      editor.add(ReadSession(ctx))
    })

    // V1's chat.message hook injected referenced files into the new session
    // after the handoff prompt was sent. The V2 prompt hook attaches them as
    // prompt file attachments before admission, which OpenCode resolves
    // through its normal attachment loading path.
    const promptRegistration = await ctx.session.hook("prompt", async (event) => {
      const { sessionID, prompt } = event

      if (processedSessions.has(sessionID)) return
      if (!prompt.text.includes("Continuing work from session")) return

      processedSessions.add(sessionID)

      const fileRefs = parseFileReferences(prompt.text)
      if (fileRefs.size === 0) return

      const attachments = await buildFileAttachments(ctx.location.directory, fileRefs)
      if (attachments.length === 0) return

      const existing = new Set((prompt.files ?? []).map((file) => file.uri))
      for (const attachment of attachments) {
        if (!existing.has(attachment.uri)) {
          prompt.files ??= []
          prompt.files.push(attachment)
        }
      }
    })

    return async () => {
      abort.abort()
      await Promise.all([
        commandRegistration.dispose(),
        toolRegistration.dispose(),
        promptRegistration.dispose(),
      ])
    }
  },
})
