/**
 * Tool definitions for opencode-handoff plugin (OpenCode V2 API).
 *
 * Factory functions that create V2 tool definitions with injected
 * dependencies:
 * - HandoffSession: Create a new session with the handoff prompt
 * - ReadSession: Read conversation transcript from a session
 *
 * NOTE (V1 -> V2 behavior change): the V2 plugin context exposes no TUI
 * domain, so `handoff_session` can no longer open an editable TUI draft
 * (`session_new` + `appendPrompt` + toast). Instead it creates a new
 * session server-side and submits the handoff prompt to it directly.
 */

import type { Plugin } from "@opencode/plugin"

type Context = Plugin.Context

/**
 * Create the handoff_session tool definition.
 *
 * Takes the V2 plugin context as a dependency for session operations.
 */
export function createHandoffSessionTool(ctx: Context) {
  return {
    name: "handoff_session",
    description: "Create a new session with the handoff prompt as its first message",
    input: {
      type: "object" as const,
      properties: {
        prompt: { type: "string" as const, description: "The generated handoff prompt" },
        files: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Array of file paths to load into the new session's context",
        },
      },
      required: ["prompt"] as const,
      additionalProperties: false as const,
    },
    async execute(input: unknown, context: { sessionID: string }) {
      const args = input as { prompt: string; files?: string[] }
      const sessionReference = `Continuing work from session ${context.sessionID}. When you lack specific information you can use read_session to get it.`
      const fileRefs = args.files?.length
        ? args.files.map(f => `@${f.replace(/^@/, '')}`).join(' ')
        : ''
      const fullPrompt = fileRefs
        ? `${sessionReference}\n\n${fileRefs}\n\n${args.prompt}`
        : `${sessionReference}\n\n${args.prompt}`

      const created = await ctx.session.create({ title: "Handoff" })
      await ctx.session.prompt({ sessionID: created.id, text: fullPrompt })

      return { content: `Handoff prompt submitted in new session ${created.id}.` }
    },
  }
}

/**
 * Narrow an unknown session message to the fields formatTranscript reads.
 */
interface TranscriptMessage {
  readonly type: string
  readonly text?: unknown
  readonly files?: ReadonlyArray<{ readonly name?: unknown; readonly uri?: unknown }>
  readonly content?: ReadonlyArray<{
    readonly type?: unknown
    readonly text?: unknown
    readonly name?: unknown
    readonly state?: { readonly status?: unknown }
  }>
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  )
}

/**
 * Format a conversation transcript for display.
 *
 * Accepts V2 `SessionMessage.Info` values (discriminated by `type`).
 *
 * @param messages - Messages from session.context(), oldest first
 * @param limit - Number of messages shown (for the truncation notice)
 * @param truncated - Whether older messages were cut off by the limit
 * @returns Formatted transcript with user/assistant sections
 */
export function formatTranscript(
  messages: readonly unknown[],
  limit: number,
  truncated: boolean
): string {
  const lines: string[] = []

  for (const raw of messages) {
    if (!isTranscriptMessage(raw)) continue

    if (raw.type === "user" && typeof raw.text === "string") {
      lines.push("## User")
      lines.push(raw.text)
      for (const file of raw.files ?? []) {
        const label =
          typeof file.name === "string" && file.name
            ? file.name
            : typeof file.uri === "string"
              ? file.uri
              : "file"
        lines.push(`[Attached: ${label}]`)
      }
      lines.push("")
    }

    if (raw.type === "assistant" && Array.isArray(raw.content)) {
      lines.push("## Assistant")
      for (const part of raw.content) {
        if (part.type === "text" && typeof part.text === "string") {
          lines.push(part.text)
        }
        if (part.type === "tool" && typeof part.name === "string") {
          const status =
            typeof part.state?.status === "string" ? ` ${part.state.status}` : ""
          lines.push(`[Tool: ${part.name}]${status}`)
        }
      }
      lines.push("")
    }
  }

  const output = lines.join("\n").trim()

  if (truncated) {
    return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
  }

  if (limit > 0 && messages.length >= limit) {
    return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
  }

  return output + `\n\n(End of session - ${messages.length} messages)`
}

/**
 * Create the read_session tool definition.
 *
 * Takes the V2 plugin context as a dependency for session.context() calls.
 * NOTE: V2 `session.context` takes no limit parameter, so the limit is
 * applied client-side by keeping the most recent N messages.
 */
export function createReadSessionTool(ctx: Context) {
  return {
    name: "read_session",
    description: "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the handoff summary.",
    input: {
      type: "object" as const,
      properties: {
        sessionID: { type: "string" as const, description: "The full session ID (e.g., sess_01jxyz...)" },
        limit: { type: "number" as const, description: "Maximum number of messages to read (defaults to 100, max 500)" },
      },
      required: ["sessionID"] as const,
      additionalProperties: false as const,
    },
    async execute(input: unknown) {
      const args = input as { sessionID: string; limit?: number }
      const limit = Math.min(args.limit ?? 100, 500)

      try {
        const messages = await ctx.session.context({ sessionID: args.sessionID })

        if (!messages || messages.length === 0) {
          return { content: "Session has no messages or does not exist." }
        }

        const truncated = messages.length > limit
        const visible = truncated ? messages.slice(-limit) : messages
        return { content: formatTranscript(visible, limit, truncated) }
      } catch (error) {
        return { content: `Could not read session ${args.sessionID}: ${error instanceof Error ? error.message : 'Unknown error'}` }
      }
    },
  }
}
