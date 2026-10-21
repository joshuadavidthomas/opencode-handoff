/**
 * Tool definitions for opencode-handoff plugin.
 *
 * Factory functions that create tool definitions with injected dependencies:
 * - HandoffSession: Start a new session with the handoff prompt
 * - ReadSession: Read conversation transcript from a session
 */

import type { Plugin } from "@opencode/plugin"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import { buildFileAttachments, parseFileReferences } from "./files"

type Context = Plugin.Context
type SessionMessages = Awaited<ReturnType<Context["session"]["context"]>>

export interface HandoffDraft {
  readonly sourceSessionID: string
  readonly agent: string
  readonly text: string
}

export type HandoffStarted = { sessionID: string; files: number }
export type HandoffOutcome = HandoffStarted | { cancelled: true }

/** Offers a draft for review and resolves with the user's decision, or with the session started without review if no TUI claimed it. */
export type ReviewDraft = (draft: HandoffDraft, signal: AbortSignal) => Promise<HandoffOutcome>

/**
 * Start the handoff session with the source session's agent and model,
 * attaching every @file the draft references.
 */
export async function startHandoff(ctx: Context, draft: HandoffDraft): Promise<HandoffStarted> {
  const files = await buildFileAttachments(ctx.location.directory, parseFileReferences(draft.text))
  const source = await ctx.session.get({ sessionID: draft.sourceSessionID })
  const session = await ctx.session.create({ agent: draft.agent, model: source.model })
  await ctx.session.prompt({ sessionID: session.id, text: draft.text, files })
  return { sessionID: session.id, files: files.length }
}

/**
 * Create the handoff_session tool. The draft goes to the TUI for review; if
 * no TUI claims it, the session starts without review.
 */
export const HandoffSession = (ctx: Context, review: ReviewDraft): ToolInfo => ({
  name: "handoff_session",
  description: "Start a new session with the handoff prompt and the files it references",
  input: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The generated handoff prompt" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Array of file paths to load into the new session's context",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const args = input as { prompt: string; files?: string[] }
    const sessionReference = `Continuing work from session ${context.sessionID}. When you lack specific information you can use read_session to get it.`
    const fileRefs = args.files?.map((file) => `@${file.replace(/^@/, "")}`).join(" ")
    const text = [sessionReference, fileRefs, args.prompt].filter(Boolean).join("\n\n")
    const draft = { sourceSessionID: context.sessionID, agent: context.agent, text }

    const outcome = await review(draft, context.signal)
    if ("cancelled" in outcome) return { content: "The user cancelled the handoff." }
    return { content: `Started handoff session ${outcome.sessionID} with ${outcome.files} attached file(s).` }
  },
})

/**
 * Format a conversation transcript for display.
 *
 * @param messages - The most recent messages from session.context()
 * @param total - Total message count in the session, before the limit
 * @returns Formatted transcript with user/assistant sections
 */
function formatTranscript(messages: SessionMessages, total: number): string {
  const lines: string[] = []

  for (const msg of messages) {
    if (msg.type === "user") {
      lines.push("## User")
      if (msg.text) {
        lines.push(msg.text)
      }
      for (const file of msg.files ?? []) {
        const label = file.name ?? (file.source.type === "uri" ? file.source.uri : "file")
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

  if (total > messages.length) {
    return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
  }

  return output + `\n\n(End of session - ${total} messages)`
}

/**
 * Summarize a completed tool call by the first line of its text result,
 * since V2 tool state has no one-line title.
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
 * session.context() takes no limit, so the transcript is trimmed here.
 */
export const ReadSession = (ctx: Context): ToolInfo => ({
  name: "read_session",
  description: "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the handoff summary.",
  input: {
    type: "object",
    properties: {
      sessionID: { type: "string", description: "The full session ID (e.g., sess_01jxyz...)" },
      limit: { type: "number", description: "Maximum number of messages to read (defaults to 100, max 500)" },
    },
    required: ["sessionID"],
    additionalProperties: false,
  },
  async execute(input) {
    const args = input as { sessionID: string; limit?: number }
    const limit = Math.min(args.limit ?? 100, 500)

    try {
      const messages = await ctx.session.context({ sessionID: args.sessionID })

      if (messages.length === 0) {
        return { content: "Session has no messages or does not exist." }
      }

      return { content: formatTranscript(messages.slice(-limit), messages.length) }
    } catch (error) {
      return {
        content: `Could not read session ${args.sessionID}: ${error instanceof Error ? error.message : "Unknown error"}`,
      }
    }
  },
})
