import { Plugin } from "@opencode/plugin"
import { Handoff } from "./rpc"
import { HandoffSession, ReadSession, startHandoff, type HandoffDraft, type HandoffOutcome } from "./tools"

/** How long a TUI has to claim a draft before the handoff starts without review. */
export const CLAIM_TIMEOUT_MS = 3000

const HANDOFF_COMMAND = `GOAL: You are creating a handoff message to continue work in a new session.

<context>
When an AI assistant starts a fresh session, it spends significant time exploring the codebase—grepping, reading files, searching—before it can begin actual work. This "file archaeology" is wasteful when the previous session already discovered what matters.

A good handoff frontloads everything the next session needs so it can start implementing immediately.

The new session receives NO file contents. Instead, it gets a manifest of files with precise descriptions, and it reads each file itself with its tools — in the order it prefers, keeping its context manageable (tool results are far easier to manage than attached content).
</context>

<instructions>
Analyze this conversation and extract what matters for continuing the work.

1. Build a file manifest for the next session

   List the files that matter for continuing this work: files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs. Listing is VERY cheap—each file costs one line and the new session reads nothing it has not chosen to read—so there is no upper bound. List every file that could matter; missing a critical one means another archaeology dig.

   Order the files by importance, most important first. If there are more than 10, the most important 10 become the main manifest and the rest are listed separately as "other context".

   For each file, describe exactly what is in it: the key functions, types, or sections it contains; its current state where that matters (partial edits, known failures, TODOs); and why it matters for this work. Name concrete symbols—a description like "config file" is useless; "test/tools.test.ts: covers handoff_session draft assembly and ReadSession transcript formatting" is usable.

   Never use @file references in the prompt or anywhere else. The manifest you pass to handoff_session is the only file list; the descriptions are how the new session decides what to read and in what order.

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

After generating the handoff message, IMMEDIATELY call handoff_session with your prompt and file manifest:
\`handoff_session(prompt="...", files=[{path: "src/foo.ts", description: "what is in this file and why it matters"}, ...])\``

export default Plugin.define({
  id: "opencode-handoff",
  async setup(ctx) {
    // `claim` is set while the draft is waiting for a TUI to claim it. `settle`
    // and `fail` finish the handoff_session call that is waiting on the draft.
    const drafts = new Map<
      string,
      {
        draft: HandoffDraft
        claim?: () => void
        settle: (outcome: HandoffOutcome) => void
        fail: (error: unknown) => void
      }
    >()

    const rpc = await ctx.rpc.register(Handoff, {
      async claim(input) {
        const pending = drafts.get((input as { draftID: string }).draftID)
        if (!pending?.claim) return { claimed: false }
        pending.claim()
        pending.claim = undefined
        return { claimed: true }
      },
      async start(input, context) {
        const { draftID, text } = input as { draftID: string; text: string }
        const pending = drafts.get(draftID)
        if (!pending || pending.claim) return context.error("not_found", "Handoff draft not found", { draftID })
        drafts.delete(draftID)
        try {
          const outcome = await startHandoff(ctx, { ...pending.draft, text })
          pending.settle(outcome)
          return { sessionID: outcome.sessionID }
        } catch (error) {
          pending.fail(error)
          throw error
        }
      },
      async cancel(input) {
        const draftID = (input as { draftID: string }).draftID
        drafts.get(draftID)?.settle({ cancelled: true })
        drafts.delete(draftID)
        return {}
      },
    })

    function review(draft: HandoffDraft, signal: AbortSignal) {
      const draftID = crypto.randomUUID()
      return new Promise<HandoffOutcome>((resolve, reject) => {
        const timer = setTimeout(() => {
          drafts.delete(draftID)
          resolve(startWithoutReview(draft))
        }, CLAIM_TIMEOUT_MS)
        drafts.set(draftID, { draft, claim: () => clearTimeout(timer), settle: resolve, fail: reject })
        // Interrupting the source session abandons the draft; a later send from the dialog fails as not found.
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            drafts.delete(draftID)
            resolve({ cancelled: true })
          },
          { once: true }
        )
        rpc.events.emit("draft", { draftID, sourceSessionID: draft.sourceSessionID, text: draft.text }).catch(reject)
      })
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "handoff",
        description: "Create a focused handoff prompt for a new session",
        async execute({ sessionID, prompt, delivery }) {
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
            text: HANDOFF_COMMAND.replaceAll("$ARGUMENTS", () => prompt.text),
          })
        },
      })
    })

    async function startWithoutReview(draft: HandoffDraft) {
      const outcome = await startHandoff(ctx, draft)
      await rpc.events.emit("started", { sessionID: outcome.sessionID, sourceSessionID: draft.sourceSessionID })
      return outcome
    }

    await ctx.tool.transform((editor) => {
      editor.add(HandoffSession(ctx, ctx.options.review === false ? startWithoutReview : review))
      editor.add(ReadSession(ctx))
    })
  },
})
