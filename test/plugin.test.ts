import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import HandoffPlugin from "../src/plugin"

type Context = Plugin.Context

type PromptHookEvent = {
  sessionID: string
  messageID: string
  prompt: { text: string; files?: Array<{ uri: string; name?: string }> }
}

/** Async event stream that lets tests push events into the plugin's subscription. */
class FakeEventStream {
  private queue: unknown[] = []
  private waiting: ((result: IteratorResult<unknown>) => void) | undefined

  push(event: unknown) {
    const waiter = this.waiting
    if (waiter) {
      this.waiting = undefined
      waiter({ value: event, done: false })
    } else {
      this.queue.push(event)
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.queue.shift()
        if (value !== undefined) {
          return Promise.resolve({ value, done: false as const })
        }
        return new Promise<IteratorResult<unknown>>((resolve) => {
          this.waiting = resolve
        })
      },
      return: () => Promise.resolve({ value: undefined, done: true as const }),
    }
  }
}

interface Captured {
  commands: Array<{
    name: string
    description?: string
    execute: (input: {
      sessionID: string
      prompt: { text: string }
      delivery: string
    }) => Promise<void>
  }>
  tools: Array<{ name: string; description: string; input: unknown }>
  promptHook: ((event: PromptHookEvent) => Promise<void>) | undefined
  promptCalls: unknown[]
}

function createContext(directory: string, events: FakeEventStream) {
  const captured: Captured = {
    commands: [],
    tools: [],
    promptHook: undefined,
    promptCalls: [],
  }
  const registration = { async dispose() {} }

  const ctx = {
    location: { directory },
    event: {
      subscribe(_options?: unknown) {
        return events
      },
    },
    command: {
      async transform(callback: (editor: { add(def: unknown): void }) => void) {
        callback({
          add(def) {
            captured.commands.push(def as Captured["commands"][number])
          },
        })
        return registration
      },
    },
    tool: {
      async transform(callback: (editor: { add(def: unknown): void }) => void) {
        callback({
          add(def) {
            captured.tools.push(def as Captured["tools"][number])
          },
        })
        return registration
      },
    },
    session: {
      async hook(name: string, callback: (event: PromptHookEvent) => Promise<void>) {
        if (name === "prompt") captured.promptHook = callback
        return registration
      },
      async prompt(input: unknown) {
        captured.promptCalls.push(input)
      },
    },
  }

  return { ctx: ctx as unknown as Context, captured }
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("HandoffPlugin", () => {
  test("registers the handoff command and tools", async () => {
    const { ctx, captured } = createContext(
      "/tmp/project",
      new FakeEventStream()
    )

    const cleanup = await HandoffPlugin.setup(ctx)

    expect(captured.commands).toHaveLength(1)
    expect(captured.commands[0]?.name).toBe("handoff")
    expect(captured.tools.map((tool) => tool.name)).toEqual([
      "handoff_session",
      "read_session",
    ])

    // The command expands $ARGUMENTS into the template and submits it to the
    // current session, preserving the invocation's delivery mode.
    await captured.commands[0]?.execute({
      sessionID: "sess_current",
      prompt: { text: "implement X" },
      delivery: "steer",
    })

    const call = captured.promptCalls[0] as {
      sessionID: string
      text: string
      delivery: string
    }
    expect(call.sessionID).toBe("sess_current")
    expect(call.delivery).toBe("steer")
    expect(call.text).toContain("GOAL: You are creating a handoff message")
    expect(call.text).toContain("USER: implement X")

    await cleanup?.()
  })

  test("attaches referenced files once per session and resets after deletion", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "opencode-handoff-plugin-")
    )

    try {
      await writeFile(join(directory, "note.txt"), "handoff context")

      const events = new FakeEventStream()
      const { ctx, captured } = createContext(directory, events)
      await HandoffPlugin.setup(ctx)

      const hook = captured.promptHook
      expect(hook).toBeDefined()

      // Prompts without the handoff marker are left untouched.
      const ordinary: PromptHookEvent = {
        sessionID: "sess_other",
        messageID: "msg_0",
        prompt: { text: "ordinary message @note.txt" },
      }
      await hook?.(ordinary)
      expect(ordinary.prompt.files).toBeUndefined()

      const handoff: PromptHookEvent = {
        sessionID: "sess_next",
        messageID: "msg_1",
        prompt: {
          text: "Continuing work from session sess_source @note.txt @missing.txt",
        },
      }
      await hook?.(handoff)
      expect(handoff.prompt.files).toEqual([
        {
          uri: pathToFileURL(join(directory, "note.txt")).href,
          name: "note.txt",
        },
      ])

      // A second handoff prompt in the same session does not re-attach.
      const repeated: PromptHookEvent = {
        sessionID: "sess_next",
        messageID: "msg_2",
        prompt: { text: handoff.prompt.text },
      }
      await hook?.(repeated)
      expect(repeated.prompt.files).toBeUndefined()

      // Attachments already present on the prompt are not duplicated.
      const preattached: PromptHookEvent = {
        sessionID: "sess_two",
        messageID: "msg_3",
        prompt: {
          text: "Continuing work from session sess_source @note.txt",
          files: [{ uri: pathToFileURL(join(directory, "note.txt")).href }],
        },
      }
      await hook?.(preattached)
      expect(preattached.prompt.files).toHaveLength(1)

      // Deleting the session resets the dedupe so a reused session attaches again.
      events.push({
        type: "session.deleted",
        data: { sessionID: "sess_next" },
      })
      await flushEvents()

      const afterDeletion: PromptHookEvent = {
        sessionID: "sess_next",
        messageID: "msg_4",
        prompt: { text: handoff.prompt.text },
      }
      await hook?.(afterDeletion)
      expect(afterDeletion.prompt.files).toEqual([
        {
          uri: pathToFileURL(join(directory, "note.txt")).href,
          name: "note.txt",
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
