/**
 * opencode-handoff plugin (OpenCode V2 API).
 *
 * V1 -> V2 mapping:
 * - V1 `config` command template -> `ctx.command.transform` with execute()
 * - V1 `tool` map (tool() helper) -> `ctx.tool.transform` (JSON Schema + { content } result)
 * - V1 `chat.message` hook -> `ctx.session.hook("prompt")` (admission-time injection)
 * - V1 `event` hook -> `ctx.event.subscribe()` with AbortController cleanup
 */
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin } from "@opencode/plugin"
import { parseFileReferences, resolveHandoffFiles, FILE_REGEX } from "./files"
import { createHandoffSessionTool, createReadSessionTool } from "./tools"

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
const HANDOFF_MARKER = "Continuing work from session"

export default Plugin.define({
  id: "opencode-handoff",
  async setup(ctx) {
    const processedSessions = new Set<string>()

    // V1 `config.command["handoff"]` template -> V2 command transform.
    // The user's command arguments arrive as prompt.text ($ARGUMENTS).
    await ctx.command.transform((editor) => {
      editor.add({
        name: "handoff",
        description: "Create a focused handoff prompt for a new session",
        execute: async ({ sessionID, prompt, delivery }) => {
          const text = HANDOFF_COMMAND.replace("$ARGUMENTS", prompt.text ?? "")
          await ctx.session.prompt({
            sessionID,
            text,
            files: prompt.files,
            delivery,
          })
        },
      })
    })

    // V1 `tool` map -> V2 tool transform (JSON Schema inputs, { content } results).
    await ctx.tool.transform((editor) => {
      editor.add(createHandoffSessionTool(ctx))
      editor.add(createReadSessionTool(ctx))
    })

    // V1 `chat.message` (post-message injection of synthetic Read parts via a
    // noReply prompt) -> V2 `prompt` hook (admission-time injection).
    // When the handoff prompt is admitted, resolve its @file references and
    // attach them so they follow the normal attachment resolution path.
    // Resolved refs are de-sigiled (`@a` -> "`a`") so the mention resolver
    // does not load them a second time.
    await ctx.session.hook("prompt", async (event) => {
      const sessionID = event.sessionID

      if (processedSessions.has(sessionID)) return

      const text = event.prompt.text ?? ""
      if (!text.includes(HANDOFF_MARKER)) return

      processedSessions.add(sessionID)

      const fileRefs = parseFileReferences(text)
      if (fileRefs.size === 0) return

      const files = await resolveHandoffFiles(ctx.location.directory, fileRefs)
      if (files.length === 0) return

      event.prompt.files ??= []
      for (const filepath of files) {
        event.prompt.files.push({ uri: pathToFileURL(filepath).href })
      }

      // De-sigil resolved refs (`@a` -> "`a`") so the mention resolver does
      // not load them a second time. Unresolved refs keep their @sigil so
      // normal resolution can still attempt them.
      const resolvedPaths = new Set(files)
      const resolvedRefs = new Set(
        [...fileRefs].filter((ref) =>
          resolvedPaths.has(path.resolve(ctx.location.directory, ref))
        )
      )
      event.prompt.text = text.replace(FILE_REGEX, (match, ref: string) =>
        resolvedRefs.has(ref) ? `\`${ref}\`` : match
      )
    })

    // V1 `event` hook (session.deleted resets injection state) -> V2 event
    // subscription, aborted in the setup cleanup function.
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.deleted") {
          processedSessions.delete(event.data.sessionID)
        }
      }
    })()

    return () => controller.abort()
  },
})
