import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

function formatTranscript(messages: Array<{ info: any; parts: any[] }>, limit?: number): string {
  const lines: string[] = []
  
  for (const msg of messages) {
    if (msg.info.role === "user") {
      lines.push("## User")
      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored) {
          lines.push(part.text)
        }
        if (part.type === "file") {
          lines.push(`[Attached: ${part.filename || "file"}]`)
        }
      }
      lines.push("")
    }
    
    if (msg.info.role === "assistant") {
      lines.push("## Assistant")  
      for (const part of msg.parts) {
        if (part.type === "text") {
          lines.push(part.text)
        }
        if (part.type === "tool" && part.state.status === "completed") {
          lines.push(`[Tool: ${part.tool}] ${part.state.title}`)
        }
      }
      lines.push("")
    }
  }
  
  const output = lines.join("\n").trim()
  
  if (messages.length >= (limit ?? 100)) {
    return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
  }
  
  return output + `\n\n(End of session - ${messages.length} messages)`
}

export const HandoffPlugin: Plugin = async (ctx) => ({
  config: async (config) => {
    config.command = config.command || {}
    config.command["handoff"] = {
      description: "Create a focused handoff prompt for a new session",
      template: `You are creating a handoff message to continue work in a new session.

User's goal: $ARGUMENTS

When an AI assistant starts a fresh session, it spends significant time exploring the codebase—grepping, reading files, searching—before it can begin actual work. This "file archaeology" is wasteful when the previous session already discovered what matters.

A good handoff frontloads everything the next session needs so it can start implementing immediately.

Analyze this conversation and extract what matters for continuing the work.

## OUTPUT FORMAT

1. LINE 1 (Required)
   
   Always start with exactly this line, replacing the placeholder with the current session ID:
   
   Continuing work from session [CURRENT_SESSION_ID]. When you lack specific information you can use read_session to get it.

2. FILE REFERENCES
   
   Include all relevant @file references on a SINGLE LINE, space-separated.

   Why: Every @file gets loaded into context automatically. The next session won't need to search—the files are already there. This eliminates exploration entirely.

   Include files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs. Be generous—the cost of an extra file is low; missing a critical one means another archaeology dig. Target 8-15 files, up to 20 for complex work.

3. CONTEXT AND GOAL

   After the files, describe what we're working on and provide whatever context helps continue the work. Structure it based on what fits the conversation—could be tasks, findings, a simple paragraph, or detailed steps.

   Preserve: decisions, constraints, user preferences, technical patterns.

   Exclude: conversation back-and-forth, dead ends, meta-commentary.

The user controls what context matters. If they mentioned something to preserve, include it—trust their judgment about their workflow.

---

After generating the handoff message, IMMEDIATELY call handoff_prepare with the full message as a handoff prompt:
\`handoff_prepare(prompt="...")\``,
    }
  },

  tool: {
    handoff_prepare: tool({
      description: "Prepare handoff by creating new session with generated prompt as draft",
      args: {
        prompt: tool.schema.string().describe("The generated handoff prompt"),
      },
      async execute(args, context) {
        await ctx.client.tui.clearPrompt()
        await ctx.client.tui.executeCommand({ body: { command: "session_new" } })
        await new Promise(r => setTimeout(r, 200))
        await ctx.client.tui.appendPrompt({ body: { text: args.prompt } })

        await ctx.client.tui.showToast({
          body: {
            title: "Handoff Ready",
            message: "Review and edit the draft, then send",
            variant: "success",
            duration: 4000,
          }
        })

        return "Handoff prompt created in new session. Review and edit before sending."
      }
    }),

    read_session: tool({
      description: "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the handoff summary.",
      args: {
        sessionID: tool.schema.string().describe("The full session ID (e.g., sess_01jxyz...)"),
        limit: tool.schema.number().optional().describe("Maximum number of messages to read (defaults to 100, max 500)"),
      },
      async execute(args, context) {
        const limit = Math.min(args.limit ?? 100, 500)
        
        try {
          const response = await ctx.client.session.messages({
            path: { id: args.sessionID },
            query: { limit }
          })
          
          if (!response.data || response.data.length === 0) {
            return "Session has no messages or does not exist."
          }
          
          const formatted = formatTranscript(response.data, limit)
          return formatted
        } catch (error) {
          return `Could not read session ${args.sessionID}: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      }
    })
  }
})
