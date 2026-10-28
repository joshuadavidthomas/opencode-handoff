import { afterEach, describe, expect, jest, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import HandoffPlugin from "../index"
import { CLAIM_TIMEOUT_MS } from "../src/plugin"

type Handler = (input: unknown, context: unknown) => Promise<unknown>

const RPC_CONTEXT = {
  signal: new AbortController().signal,
  error: (type: string, message: string, data: unknown) => ({ type, message, data }),
}

async function setupPlugin(options: Record<string, unknown> = {}) {
  const commands: Record<string, CommandDefinition> = {}
  const tools: Record<string, ToolInfo> = {}
  const handlers: Record<string, Handler> = {}
  const drafts: Array<{ draftID: string; sourceSessionID: string; text: string }> = []
  const started: unknown[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const ctx = {
    location: { directory: "/tmp/project" },
    options,
    rpc: {
      async register(definition: { id: string }, registered: Record<string, Handler>) {
        expect(definition.id).toBe("opencode-handoff")
        Object.assign(handlers, registered)
        return {
          events: {
            async emit(name: string, data: never) {
              if (name === "draft") drafts.push(data)
              else if (name === "started") started.push(data)
              else throw new Error(`unexpected event ${name}`)
            },
          },
        }
      },
    },
    command: {
      async transform(transform: (editor: { add(command: CommandDefinition): void }) => void) {
        transform({ add: (command) => { commands[command.name] = command } })
      },
    },
    tool: {
      async transform(transform: (editor: { add(tool: ToolInfo): void }) => void) {
        transform({ add: (tool) => { tools[tool.name] = tool } })
      },
    },
    session: {
      async get() {
        return { id: "sess_source" }
      },
      async create() {
        return { id: "sess_new" }
      },
      async prompt(input: never) {
        prompts.push(input)
      },
    },
  } as unknown as Plugin.Context

  await HandoffPlugin.setup(ctx)

  /** Run handoff_session until its draft has been announced. */
  async function handoff() {
    const abort = new AbortController()
    let done = false
    const result = tools.handoff_session!.execute(
      { prompt: "Continue the work" },
      { sessionID: "sess_source", agent: "plan", signal: abort.signal } as never
    )
    result.then(() => (done = true))
    while (drafts.length === 0) await Promise.resolve()
    return { result, draft: drafts.at(-1)!, abort, done: () => done }
  }

  return { commands, tools, handlers, prompts, drafts, started, handoff }
}

afterEach(() => {
  jest.useRealTimers()
})

describe("HandoffPlugin", () => {
  test("registers the handoff command and tools", async () => {
    const { commands, tools } = await setupPlugin()

    expect(HandoffPlugin.id).toBe("opencode-handoff")
    expect(Object.keys(commands)).toEqual(["handoff"])
    expect(Object.keys(tools).sort()).toEqual(["handoff_session", "read_session"])
  })

  test("/handoff submits the template with the user's goal and attachments", async () => {
    const { commands, prompts } = await setupPlugin()
    const files = [{ uri: "file:///tmp/project/spec.md" }]

    await commands.handoff!.execute({
      sessionID: "sess_source",
      delivery: "queue",
      prompt: { text: "keep $& and $' literal", files },
    } as never)

    expect(prompts).toHaveLength(1)
    const prompt = prompts[0] as unknown as { sessionID: string; delivery: string; text: string; files: unknown }
    expect(prompt.sessionID).toBe("sess_source")
    expect(prompt.delivery).toBe("queue")
    expect(prompt.files).toEqual(files)
    expect(prompt.text).toContain("USER: keep $& and $' literal\n")
    expect(prompt.text).not.toContain("$ARGUMENTS")
  })

  test("a claimed draft waits for the user, then reports the session they sent", async () => {
    jest.useFakeTimers()
    const { handlers, prompts, handoff } = await setupPlugin()
    const { result, draft, done } = await handoff()

    expect(draft.sourceSessionID).toBe("sess_source")
    expect(draft.text).toContain("Continue the work")
    expect(await handlers.claim!({ draftID: draft.draftID }, RPC_CONTEXT)).toEqual({ claimed: true })
    expect(await handlers.claim!({ draftID: draft.draftID }, RPC_CONTEXT)).toEqual({ claimed: false })

    // A slow review must not fall back to starting the session without the user.
    jest.advanceTimersByTime(CLAIM_TIMEOUT_MS * 10)
    await Promise.resolve()
    expect(done()).toBe(false)
    expect(prompts).toEqual([])

    expect(await handlers.start!({ draftID: draft.draftID, text: "Edited handoff" }, RPC_CONTEXT)).toEqual({
      sessionID: "sess_new",
    })
    expect(prompts).toEqual([{ sessionID: "sess_new", text: "Edited handoff" } as never])
    expect((await result).content).toBe(
      "Started handoff session sess_new with 0 listed file(s) — contents are not attached, the new session reads them itself."
    )
    expect(await handlers.start!({ draftID: draft.draftID, text: "again" }, RPC_CONTEXT)).toMatchObject({
      type: "not_found",
    })
  })

  test("a cancelled draft never starts and the tool reports the cancel", async () => {
    const { handlers, prompts, handoff } = await setupPlugin()
    const { result, draft } = await handoff()

    await handlers.claim!({ draftID: draft.draftID }, RPC_CONTEXT)
    await handlers.cancel!({ draftID: draft.draftID }, RPC_CONTEXT)

    expect((await result).content).toBe("The user cancelled the handoff.")

    expect(await handlers.start!({ draftID: draft.draftID, text: "Edited" }, RPC_CONTEXT)).toMatchObject({
      type: "not_found",
    })
    expect(prompts).toEqual([])
  })

  test("interrupting the source session stops waiting on the review", async () => {
    const { handlers, prompts, handoff } = await setupPlugin()
    const { result, draft, abort } = await handoff()

    await handlers.claim!({ draftID: draft.draftID }, RPC_CONTEXT)
    abort.abort()

    expect((await result).content).toBe("The user cancelled the handoff.")
    expect(await handlers.start!({ draftID: draft.draftID, text: "Edited" }, RPC_CONTEXT)).toMatchObject({
      type: "not_found",
    })
    expect(prompts).toEqual([])
  })

  test("with review off, starts the session right away and tells the TUI", async () => {
    const { tools, prompts, drafts, started } = await setupPlugin({ review: false })

    const result = await tools.handoff_session!.execute(
      { prompt: "Continue the work" },
      { sessionID: "sess_source", agent: "plan", signal: new AbortController().signal } as never
    )

    expect(result.content).toBe(
      "Started handoff session sess_new with 0 listed file(s) — contents are not attached, the new session reads them itself."
    )
    expect(drafts).toEqual([])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toEqual({
      sessionID: "sess_new",
      text: "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.\n\nContinue the work",
    })
    expect(started).toEqual([{ sessionID: "sess_new", sourceSessionID: "sess_source" }])
  })

  test("starts the handoff without review when no TUI claims the draft", async () => {
    jest.useFakeTimers()
    const { handlers, prompts, started, handoff } = await setupPlugin()
    const { result, draft } = await handoff()

    jest.advanceTimersByTime(CLAIM_TIMEOUT_MS)

    expect((await result).content).toBe(
      "Started handoff session sess_new with 0 listed file(s) — contents are not attached, the new session reads them itself."
    )
    expect(prompts).toEqual([{ sessionID: "sess_new", text: draft.text } as never])
    expect(started).toEqual([{ sessionID: "sess_new", sourceSessionID: "sess_source" }])
    expect(await handlers.claim!({ draftID: draft.draftID }, RPC_CONTEXT)).toEqual({ claimed: false })
  })
})
