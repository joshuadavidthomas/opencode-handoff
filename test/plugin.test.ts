import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/plugin"

type Context = Plugin.Context

interface CapturedHook {
  name: string
  callback: (event: any) => unknown
}

function createEventBus() {
  const queue: Array<any> = []
  const waiters: Array<() => void> = []
  return {
    push(event: any) {
      queue.push(event)
      waiters.splice(0).forEach((wake) => wake())
    },
    async *subscribe(): AsyncGenerator<any> {
      let index = 0
      for (;;) {
        if (index < queue.length) {
          yield queue[index++]
          continue
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}

function createCtx(directory: string, session: Record<string, unknown> = {}) {
  const tools: Array<any> = []
  const commands: Array<any> = []
  const hooks: Array<CapturedHook> = []
  const bus = createEventBus()
  const ctx = {
    location: { directory },
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => {
        hooks.push({ name, callback })
        return { dispose: async () => {} }
      },
      ...session,
    },
    tool: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (tool: any) => tools.push(tool) })
        return { dispose: async () => {} }
      },
    },
    command: {
      transform: async (callback: (editor: any) => void) => {
        callback({ add: (command: any) => commands.push(command) })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => bus.subscribe(),
    },
  } as unknown as Context
  return { ctx, tools, commands, hooks, bus }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("HandoffPlugin (V2)", () => {
  test("registers the handoff command and tools", async () => {
    const promptCalls: unknown[] = []
    const { ctx, tools, commands } = createCtx("/tmp/project", {
      prompt: async (input: unknown) => {
        promptCalls.push(input)
      },
    })

    const cleanup = await plugin.setup(ctx)
    expect(typeof cleanup === "function" || cleanup === undefined).toBe(true)

    expect(commands.map((c) => c.name)).toEqual(["handoff"])
    expect(commands[0]?.description).toContain("handoff")
    expect(tools.map((t) => t.name).sort()).toEqual([
      "handoff_session",
      "read_session",
    ])

    await commands[0]?.execute({
      sessionID: "sess_1",
      prompt: { text: "implement auth" },
      delivery: "steer",
    })

    expect(promptCalls).toHaveLength(1)
    const call = promptCalls[0] as { sessionID: string; text: string }
    expect(call.sessionID).toBe("sess_1")
    expect(call.text).toContain("GOAL:")
    expect(call.text).toContain("implement auth")
    expect(call.text).not.toContain("$ARGUMENTS")
  })

  test("attaches referenced files once and resets after session deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-plugin-"))

    try {
      await writeFile(join(directory, "note.txt"), "handoff context")
      const { ctx, hooks, bus } = createCtx(directory)

      const cleanup = await plugin.setup(ctx)
      const promptHook = hooks.find((h) => h.name === "prompt")
      expect(promptHook).toBeDefined()

      const handoffText =
        "Continuing work from session sess_source @note.txt @missing.txt"

      // Non-handoff prompts are ignored.
      const ordinary = { sessionID: "sess_next", prompt: { text: "ordinary message @note.txt", files: [] as any[] } }
      await promptHook!.callback(ordinary)
      expect(ordinary.prompt.files).toHaveLength(0)

      const first = { sessionID: "sess_next", prompt: { text: handoffText, files: [] as any[] } }
      await promptHook!.callback(first)

      // note.txt attached; missing.txt has no @sigil stripped but is not attached.
      expect(first.prompt.files).toHaveLength(1)
      expect(first.prompt.files[0]?.uri).toContain("note.txt")
      expect(first.prompt.text).not.toContain("@note.txt")
      expect(first.prompt.text).toContain("`note.txt`")
      expect(first.prompt.text).toContain("@missing.txt")

      // Second admission for the same session is a no-op.
      const second = { sessionID: "sess_next", prompt: { text: handoffText, files: [] as any[] } }
      await promptHook!.callback(second)
      expect(second.prompt.files).toHaveLength(0)
      expect(second.prompt.text).toBe(handoffText)

      // Session deletion resets the once-only state.
      bus.push({ type: "session.deleted", data: { sessionID: "sess_next" } })
      await tick()
      await tick()

      const third = { sessionID: "sess_next", prompt: { text: handoffText, files: [] as any[] } }
      await promptHook!.callback(third)
      expect(third.prompt.files).toHaveLength(1)

      expect(() => (cleanup as unknown as () => void)?.()).not.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
