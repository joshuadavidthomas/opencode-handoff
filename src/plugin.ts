import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

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

1. FILE REFERENCES (Required)

   Include all relevant @file references on a SINGLE LINE, space-separated.

   Why: Every @file gets loaded into context automatically. The next session won't need to search—the files are already there. This eliminates exploration entirely.

   Include files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs. Be generous—the cost of an extra file is low; missing a critical one means another archaeology dig. Target 8-15 files, up to 20 for complex work.

2. CONTEXT AND GOAL

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
    })
  }
})
