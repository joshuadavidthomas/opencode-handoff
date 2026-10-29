import { afterEach, describe, expect, jest, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import HandoffPlugin from "../index"
import { CLAIM_TIMEOUT_MS } from "../src/plugin"
import type { HandoffFile } from "../src/rpc"

type Handler = (input: unknown, context: unknown) => Promise<unknown>

const RPC_CONTEXT = {
  signal: new AbortController().signal,
  error: (type: string, message: string, data: unknown) => ({ type, message, data }),
}

async function setupPlugin(options: Record<string, unknown> = {}) {
  const commands: Record<string, CommandDefinition> = {}
  const tools: Record<string, ToolInfo> = {}
  const handlers: Record<string, Handler> = {}
  const drafts: Array<{ draftID: string; sourceSessionID: string; text: string; files: HandoffFile[]; attachFiles: boolean }> = []
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
  async function handoff(files: HandoffFile[] = []) {
    const abort = new AbortController()
    let done = false
    const result = tools.handoff_session!.execute(
      { prompt: "Continue the work", files },
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

    expect(await handlers.start!({ draftID: draft.draftID, text: "Edited handoff", files: [] }, RPC_CONTEXT)).toEqual({
      sessionID: "sess_new",
    })
    expect(prompts).toEqual([{
      sessionID: "sess_new",
      text: "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.\n\nEdited handoff",
      files: [],
    } as never])
    expect((await result).content).toBe("Started handoff session sess_new with 0 attached and 0 list-only file(s).")
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

    expect(result.content).toBe("Started handoff session sess_new with 0 attached and 0 list-only file(s).")
    expect(drafts).toEqual([])
    expect(prompts).toHaveLength(1)
    expect(started).toEqual([{ sessionID: "sess_new", sourceSessionID: "sess_source" }])
  })

  test("starts the handoff without review when no TUI claims the draft", async () => {
    jest.useFakeTimers()
    const { handlers, prompts, started, handoff } = await setupPlugin()
    const { result, draft } = await handoff()

    jest.advanceTimersByTime(CLAIM_TIMEOUT_MS)

    expect((await result).content).toBe("Started handoff session sess_new with 0 attached and 0 list-only file(s).")
    expect(prompts).toEqual([{
      sessionID: "sess_new",
      text: "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.\n\nContinue the work",
      files: [],
    } as never])
    expect(started).toEqual([{ sessionID: "sess_new", sourceSessionID: "sess_source" }])
    expect(await handlers.claim!({ draftID: draft.draftID }, RPC_CONTEXT)).toEqual({ claimed: false })
  })

  test.each(["reviewed", "timeout", "disabled"])("enforces the attachment opt-out when review is %s", async (review) => {
    const directory = await mkdtemp(join(tmpdir(), "handoff-opt-out-"))
    try {
      const path = join(directory, "working.txt")
      await writeFile(path, "important context")
      const files: HandoffFile[] = [{ path, description: "working file", mode: "attach" }]
      const plugin = await setupPlugin({ attachFiles: false, review: review !== "disabled" })
      let result
      if (review === "disabled") {
        result = await plugin.tools.handoff_session!.execute({ prompt: "Continue", files }, {
          sessionID: "sess_source", agent: "plan", signal: new AbortController().signal,
        } as never)
      } else {
        if (review === "timeout") jest.useFakeTimers()
        const pending = await plugin.handoff(files)
        expect(pending.draft).toMatchObject({ attachFiles: false, files: [{ path, description: "working file", mode: "list" }] })
        const edit = { draftID: pending.draft.draftID, text: "Edited summary", files }
        expect(await plugin.handlers.preview!(edit, RPC_CONTEXT)).toMatchObject({ type: "not_found" })
        if (review === "reviewed") {
          await plugin.handlers.claim!({ draftID: pending.draft.draftID }, RPC_CONTEXT)
          expect(await plugin.handlers.preview!(edit, RPC_CONTEXT)).toMatchObject({
            attachmentTokens: 0, files: [{ mode: "list", attachment: null }],
          })
          expect(await plugin.handlers.start!(edit, RPC_CONTEXT)).toEqual({ sessionID: "sess_new" })
          expect(await plugin.handlers.preview!(edit, RPC_CONTEXT)).toMatchObject({ type: "not_found" })
        } else {
          jest.advanceTimersByTime(CLAIM_TIMEOUT_MS)
        }
        result = await pending.result
      }
      expect(result.content).toBe("Started handoff session sess_new with 0 attached and 1 list-only file(s).")
      expect(plugin.prompts.at(-1)).toMatchObject({ sessionID: "sess_new", files: [] })
      expect(plugin.prompts.at(-1)?.text).toContain("working.txt` (list only): working file")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
