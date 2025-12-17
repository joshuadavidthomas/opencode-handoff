import type { Plugin } from "@opencode-ai/plugin"
import { HandoffSession, ReadSession } from "./tools"
import { parseFileReferences, buildFileParts } from "./files"

const HANDOFF_COMMAND = `You are creating a handoff message to continue work in a new session.

User's goal: $ARGUMENTS

When an AI assistant starts a fresh session, it spends significant time exploring the codebase—grepping, reading files, searching—before it can begin actual work. This "file archaeology" is wasteful when the previous session already discovered what matters.

A good handoff frontloads everything the next session needs so it can start implementing immediately.

Analyze this conversation and extract what matters for continuing the work.

## OUTPUT FORMAT

1. FILE REFERENCES

   Include all relevant @file references on a SINGLE LINE, space-separated.

   Why: Every @file gets loaded into context automatically. The next session won't need to search—the files are already there. This eliminates exploration entirely.

   Include files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs. Be generous—the cost of an extra file is low; missing a critical one means another archaeology dig. Target 8-15 files, up to 20 for complex work.

2. CONTEXT AND GOAL

   After the files, describe what we're working on and provide whatever context helps continue the work. Structure it based on what fits the conversation—could be tasks, findings, a simple paragraph, or detailed steps.

   Preserve: decisions, constraints, user preferences, technical patterns.

   Exclude: conversation back-and-forth, dead ends, meta-commentary.

The user controls what context matters. If they mentioned something to preserve, include it—trust their judgment about their workflow.

---

After generating the handoff message, IMMEDIATELY call handoff_session with the full message as a handoff prompt:
\`handoff_session(prompt="...")\``

export const HandoffPlugin: Plugin = async (ctx) => {
  const processedSessions = new Set<string>()

  return {
    config: async (config) => {
      config.command = config.command || {}
      config.command["handoff"] = {
        description: "Create a focused handoff prompt for a new session",
        template: HANDOFF_COMMAND,
      }
    },

    tool: {
      handoff_session: HandoffSession(ctx.client),
      read_session: ReadSession(ctx.client),
    },

    "chat.message": async (_input, output) => {
      const sessionID = output.message.sessionID

      if (processedSessions.has(sessionID)) return

      // Get non-synthetic text from the message
      const text = output.parts
        .filter((p): p is typeof p & { type: "text"; text: string } =>
          p.type === "text" && !p.synthetic && typeof p.text === "string"
        )
        .map(p => p.text)
        .join("\n")

      if (!text.includes("Continuing work from session")) return

      processedSessions.add(sessionID)

      const fileRefs = parseFileReferences(text)
      if (fileRefs.size === 0) return

      const fileParts = await buildFileParts(ctx.directory, fileRefs)
      if (fileParts.length === 0) return

      // Inject file parts via noReply
      // Must pass model and agent to prevent mode/model switching
      await ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          model: output.message.model,
          agent: output.message.agent,
          parts: fileParts,
        },
      })
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        processedSessions.delete(event.properties.info.id)
      }
    }
  }
}
