/**
 * Tool definitions for opencode-handoff plugin.
 *
 * Factory functions that create tool definitions with injected dependencies:
 * - HandoffSession: Start a new session with the handoff prompt
 * - ReadSession: Read conversation transcript from a session
 */

import type { Plugin } from "@opencode/plugin"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import { estimateTokens, prepareFiles } from "./files"
import { HandoffFileSchema, type HandoffFile, type HandoffPreview } from "./rpc"

type Context = Plugin.Context
type SessionMessages = Awaited<ReturnType<Context["session"]["context"]>>

export interface HandoffDraft {
  readonly sourceSessionID: string
  readonly agent: string
  readonly text: string
  readonly files: HandoffFile[]
}

export type HandoffStarted = { sessionID: string; files: number; listed: number }
export type HandoffOutcome = HandoffStarted | { cancelled: true }

/** Offers a draft for review and resolves with the user's decision, or with the session started without review if no TUI claimed it. */
export type ReviewDraft = (draft: HandoffDraft, signal: AbortSignal) => Promise<HandoffOutcome>

export async function prepareHandoff(ctx: Context, draft: HandoffDraft) {
  const prepared = await prepareFiles(ctx.location.directory, draft.files, ctx.options.attachFiles !== false)
  const manifest = prepared.files.length ? [
    "## Files",
    "",
    "Attached files are preloaded. Read list-only files with tools if needed.",
    "",
    ...prepared.files.map((file) => {
      const status = file.attachment === null ? "list only"
        : "tokens" in file.attachment ? "attached" : `list only: ${file.attachment.reason}`
      const name = file.path.replace(/`/g, "\\`")
      return `- \`${name}\` (${status})${file.description ? `: ${file.description}` : ""}`
    }),
  ].join("\n") : ""
  const text = [
    `Continuing work from session ${draft.sourceSessionID}. When you lack specific information you can use read_session to get it.`,
    draft.text,
    manifest,
  ].filter(Boolean).join("\n\n")
  const promptTokens = estimateTokens(text)
  let attachmentTokens: number | null = 0
  for (const file of prepared.files) {
    if (file.attachment && "reason" in file.attachment) {
      attachmentTokens = null
      break
    }
    if (file.attachment) attachmentTokens += file.attachment.tokens
  }
  const preview: HandoffPreview = {
    files: prepared.files,
    promptTokens,
    attachmentTokens,
    totalTokens: attachmentTokens === null ? null : promptTokens + attachmentTokens,
  }
  return { text, attachments: prepared.attachments, preview }
}

/** Preview and send share file resolution and policy; send always rechecks current files. */
export async function startHandoff(ctx: Context, draft: HandoffDraft): Promise<HandoffStarted> {
  const prepared = await prepareHandoff(ctx, draft)
  const source = await ctx.session.get({ sessionID: draft.sourceSessionID })
  const session = await ctx.session.create({ agent: draft.agent, model: source.model })
  await ctx.session.prompt({ sessionID: session.id, text: prepared.text, files: prepared.attachments })
  return { sessionID: session.id, files: prepared.attachments.length, listed: prepared.preview.files.length - prepared.attachments.length }
}

/**
 * Create the handoff_session tool. The draft goes to the TUI for review; if
 * no TUI claims it, the session starts without review.
 */
export const HandoffSession = (ctx: Context, review: ReviewDraft): ToolInfo => ({
  name: "handoff_session",
  description: "Start a new session with a handoff summary, a small attached working set, and a described reading list of secondary files",
  input: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The generated handoff prompt" },
      files: {
        type: "array",
        items: HandoffFileSchema,
        description: "Files in importance order. Attach only files needed immediately; list secondary files without loading their contents.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const args = input as { prompt: string; files?: HandoffFile[] }
    const draft: HandoffDraft = {
      sourceSessionID: context.sessionID,
      agent: context.agent,
      text: args.prompt,
      files: (args.files ?? []).map((file) => ctx.options.attachFiles === false ? { ...file, mode: "list" } : file),
    }

    const outcome = await review(draft, context.signal)
    if ("cancelled" in outcome) return { content: "The user cancelled the handoff." }
    return { content: `Started handoff session ${outcome.sessionID} with ${outcome.files} attached and ${outcome.listed} list-only file(s).` }
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
