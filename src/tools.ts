/**
 * Tool definitions for opencode-handoff plugin.
 *
 * Factory functions that create V2 tool definitions bound to the plugin
 * context:
 * - HandoffSession: Start a new session with the handoff prompt
 * - ReadSession: Read conversation transcript from a session
 */

import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { buildFileAttachments } from "./files"

type Context = Plugin.Context
type SessionMessages = Awaited<ReturnType<Context["session"]["context"]>>

interface HandoffSessionInput {
  prompt: string
  files?: string[]
}

interface ReadSessionInput {
  sessionID: string
  limit?: number
}

/**
 * Create the handoff_session tool.
 *
 * V1 opened a new TUI session with an editable draft via client.tui.*; the
 * V2 plugin API has no TUI control surface, so the tool now starts the new
 * session with the handoff prompt directly and attaches the referenced
 * files to the prompt through the supported attachment path.
 */
export const HandoffSession = (ctx: Context) => {
  return {
    name: "handoff_session",
    description:
      "Create a new session and start it with the handoff prompt and referenced files",
    input: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The generated handoff prompt",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of file paths to load into the new session's context",
        },
      },
      required: ["prompt"],
    },
    async execute(rawInput: unknown, context: ToolContext) {
      const input = rawInput as HandoffSessionInput

      const sessionReference = `Continuing work from session ${context.sessionID}. When you lack specific information you can use read_session to get it.`
      const fullPrompt = `${sessionReference}\n\n${input.prompt}`

      // Attach referenced files to the new session's prompt so they load
      // through OpenCode's supported attachment path. The prompt text does not
      // repeat them as @refs: the attachments already carry the content, and
      // naming the same files twice tripped the new session's compaction.
      const files = input.files?.length
        ? await buildFileAttachments(
            ctx.location.directory,
            new Set(input.files.map((file) => file.replace(/^@/, "")))
          )
        : []

      const session = await ctx.session.create({})
      await ctx.session.prompt({ sessionID: session.id, text: fullPrompt, files })

      return {
        content: `Started handoff session ${session.id} with the handoff prompt and ${files.length} attached file(s).`,
      }
    },
  }
}

/**
 * Format a conversation transcript for display.
 *
 * @param messages - The most recent slice of messages from session.context()
 * @param total - Total message count in the session, before slicing
 * @param limit - Limit the caller asked for, used for the truncation note
 * @returns Formatted transcript with user/assistant sections
 */
function formatTranscript(
  messages: SessionMessages,
  total: number,
  limit: number
): string {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.type === "user") {
      lines.push("## User")
      if (msg.text) {
        lines.push(msg.text)
      }
      for (const file of msg.files ?? []) {
        const label =
          file.name ?? (file.source.type === "uri" ? file.source.uri : "file")
        lines.push(`[Attached: ${label}]`)
      }
      lines.push("")
    }

    if (msg.type === "assistant") {
      lines.push("## Assistant")
      for (const part of msg.content) {
        if (part.type === "text") {
          lines.push(part.text)
        }
        if (part.type === "tool" && part.state.status === "completed") {
          lines.push(`[Tool: ${part.name}] ${describeToolResult(part.state.content)}`)
        }
      }
      lines.push("")
    }
  }

  const output = lines.join("\n").trim()

  if (total > limit) {
    return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
  }

  return output + `\n\n(End of session - ${total} messages)`
}

/**
 * Summarize a completed tool call from its result content.
 *
 * V2 completed tool state no longer carries V1's one-line `title`; the first
 * line of the first text content is the closest equivalent.
 */
function describeToolResult(
  content: ReadonlyArray<{ type: "text"; text: string } | { type: "file"; uri: string }>
): string {
  const text = content.find((item): item is { type: "text"; text: string } => item.type === "text")
  const firstLine = text?.text.split("\n")[0]?.trim() ?? ""
  if (!firstLine) return "completed"
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine
}

/**
 * Create the read_session tool.
 *
 * Reads transcripts via session.context(); V1's session.messages() with a
 * server-side limit no longer exists, so the transcript is fetched whole and
 * sliced to the requested limit here.
 */
export const ReadSession = (ctx: Context) => {
  return {
    name: "read_session",
    description:
      "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the handoff summary.",
    input: {
      type: "object",
      properties: {
        sessionID: {
          type: "string",
          description: "The full session ID (e.g., sess_01jxyz...)",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of messages to read (defaults to 100, max 500)",
        },
      },
      required: ["sessionID"],
    },
    async execute(rawInput: unknown) {
      const input = rawInput as ReadSessionInput
      const limit = Math.min(input.limit ?? 100, 500)

      try {
        const messages = await ctx.session.context({ sessionID: input.sessionID })

        if (!messages || messages.length === 0) {
          return { content: "Session has no messages or does not exist." }
        }

        return {
          content: formatTranscript(messages.slice(-limit), messages.length, limit),
        }
      } catch (error) {
        return {
          content: `Could not read session ${input.sessionID}: ${error instanceof Error ? error.message : "Unknown error"}`,
        }
      }
    },
  }
}
