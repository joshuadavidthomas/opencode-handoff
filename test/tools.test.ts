import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { HandoffSession, ReadSession } from "../src/tools"

type Context = Plugin.Context

function createContext(partial: Record<string, unknown>): Context {
  return partial as unknown as Context
}

const TOOL_CONTEXT = { sessionID: "sess_source", agent: "plan" } as never
const SOURCE_MODEL = { id: "model", providerID: "provider" }

function createHandoffContext(directory: string) {
  const calls: Array<{ name: string; input: unknown }> = []
  const ctx = createContext({
    location: { directory },
    session: {
      async get(input: unknown) {
        calls.push({ name: "get", input })
        return { id: "sess_source", model: SOURCE_MODEL }
      },
      async create(input: unknown) {
        calls.push({ name: "create", input })
        return { id: "sess_new" }
      },
      async prompt(input: unknown) {
        calls.push({ name: "prompt", input })
      },
    },
  })
  return { ctx, calls }
}

describe("HandoffSession", () => {
  test("starts the session itself, with every named file, when nobody reviews the draft", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-tools-"))

    try {
      await mkdir(join(directory, "src"))
      await writeFile(join(directory, "note.txt"), "handoff context")
      await writeFile(join(directory, "src", "inline.ts"), "export {}")
      await writeFile(join(directory, "image.bin"), new Uint8Array([0, 1, 2]))

      const { ctx, calls } = createHandoffContext(directory)
      const text = [
        "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.",
        "@note.txt @missing.md @image.bin",
        "Continue in @src/inline.ts using @note.txt",
      ].join("\n\n")

      const result = await HandoffSession(ctx, async () => undefined).execute(
        {
          prompt: "Continue in @src/inline.ts using @note.txt",
          files: ["note.txt", "@missing.md", "image.bin"],
        },
        TOOL_CONTEXT
      )

      expect(calls).toEqual([
        { name: "get", input: { sessionID: "sess_source" } },
        { name: "create", input: { agent: "plan", model: SOURCE_MODEL } },
        {
          name: "prompt",
          input: {
            sessionID: "sess_new",
            text,
            files: [
              { uri: pathToFileURL(join(directory, "note.txt")).href, name: "note.txt" },
              { uri: pathToFileURL(join(directory, "src", "inline.ts")).href, name: join("src", "inline.ts") },
            ],
          },
        },
      ])
      expect(result.content).toBe("Started handoff session sess_new with 2 attached file(s).")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reports the reviewer's decision instead of starting the session itself", async () => {
    const { ctx, calls } = createHandoffContext("/tmp/project")
    const drafts: unknown[] = []

    const result = await HandoffSession(ctx, async (draft) => {
      drafts.push(draft)
      return { sessionID: "sess_reviewed", files: 2 }
    }).execute({ prompt: "Continue", files: ["src/a.ts"] }, TOOL_CONTEXT)
    const cancelled = await HandoffSession(ctx, async () => ({ cancelled: true })).execute(
      { prompt: "Continue" },
      TOOL_CONTEXT
    )

    expect(drafts).toEqual([
      {
        sourceSessionID: "sess_source",
        agent: "plan",
        text: "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.\n\n@src/a.ts\n\nContinue",
      },
    ])
    expect(calls).toEqual([])
    expect(result.content).toBe("Started handoff session sess_reviewed with 2 attached file(s).")
    expect(cancelled.content).toBe("The user cancelled the handoff.")
  })
})

describe("ReadSession", () => {
  test("formats visible conversation content", async () => {
    const requests: unknown[] = []
    const ctx = createContext({
      session: {
        async context(input: unknown) {
          requests.push(input)
          return [
            {
              type: "user",
              text: "hello",
              files: [
                {
                  data: "aGVsbG8=",
                  mime: "text/plain",
                  source: { type: "uri", uri: "file:///notes.txt" },
                  name: "notes.txt",
                },
              ],
            },
            {
              type: "assistant",
              content: [
                { type: "text", text: "done" },
                {
                  type: "tool",
                  name: "read",
                  state: {
                    status: "completed",
                    content: [{ type: "text", text: "Read file" }],
                  },
                },
                {
                  type: "tool",
                  name: "write",
                  state: { status: "running" },
                },
              ],
            },
          ]
        },
      },
    })

    const result = await ReadSession(ctx).execute({
      sessionID: "sess_old",
      limit: 2,
    }, TOOL_CONTEXT)

    expect(requests).toEqual([{ sessionID: "sess_old" }])
    expect(result.content).toBe(
      [
        "## User",
        "hello",
        "[Attached: notes.txt]",
        "",
        "## Assistant",
        "done",
        "[Tool: read] Read file",
        "",
        "(End of session - 2 messages)",
      ].join("\n")
    )
  }, TOOL_CONTEXT)

  test("uses the default limit and handles an empty session", async () => {
    const requests: unknown[] = []
    const ctx = createContext({
      session: {
        async context(input: unknown) {
          requests.push(input)
          return []
        },
      },
    })

    const result = await ReadSession(ctx).execute({ sessionID: "sess_empty" }, TOOL_CONTEXT)

    expect(requests).toEqual([{ sessionID: "sess_empty" }])
    expect(result.content).toBe("Session has no messages or does not exist.")
  })

  test("slices to the last limit messages and reports truncation", async () => {
    const ctx = createContext({
      session: {
        async context() {
          return [
            { type: "user", text: "first" },
            { type: "user", text: "second" },
            { type: "user", text: "third" },
          ]
        },
      },
    })

    const result = await ReadSession(ctx).execute({
      sessionID: "sess_old",
      limit: 900,
    }, TOOL_CONTEXT)
    // 900 is capped to 500, but only 3 messages exist: nothing is truncated
    expect(result.content).toContain("(End of session - 3 messages)")

    const capped = await ReadSession(ctx).execute({
      sessionID: "sess_old",
      limit: 2,
    }, TOOL_CONTEXT)
    expect(capped.content).not.toContain("first")
    expect(capped.content).toContain("second")
    expect(capped.content).toContain("third")
    expect(capped.content).toContain(
      "(Showing 2 most recent messages. Use a higher 'limit' to see more.)"
    )
  }, TOOL_CONTEXT)

  test("turns client errors into useful output", async () => {
    const ctx = createContext({
      session: {
        async context() {
          throw new Error("offline")
        },
      },
    })

    const result = await ReadSession(ctx).execute({ sessionID: "sess_old" }, TOOL_CONTEXT)

    expect(result.content).toBe("Could not read session sess_old: offline")
  })
})
