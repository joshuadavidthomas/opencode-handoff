import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createHandoffSessionTool, createReadSessionTool } from "../src/tools"

type Context = Plugin.Context

function createCtx(overrides: Record<string, unknown> = {}): Context {
  return {
    session: {},
    ...overrides,
  } as unknown as Context
}

describe("HandoffSession", () => {
  test("creates a new session and submits the handoff prompt", async () => {
    const calls: Array<{ name: string; input: unknown }> = []
    const ctx = createCtx({
      session: {
        async create(input: unknown) {
          calls.push({ name: "create", input })
          return { id: "sess_new" }
        },
        async prompt(input: unknown) {
          calls.push({ name: "prompt", input })
        },
      },
    })

    const tool = createHandoffSessionTool(ctx)
    expect(tool.name).toBe("handoff_session")

    const result = await tool.execute(
      {
        prompt: "Continue implementation",
        files: ["src/files.ts", "@README.md"],
      },
      { sessionID: "sess_source" } as never
    )

    expect(calls.map((call) => call.name)).toEqual(["create", "prompt"])
    expect(calls[0]?.input).toEqual({ title: "Handoff" })

    const prompted = calls[1]?.input as { sessionID: string; text: string }
    expect(prompted.sessionID).toBe("sess_new")
    expect(prompted.text).toContain("Continuing work from session sess_source")
    expect(prompted.text).toContain("@src/files.ts @README.md")
    expect(prompted.text).toContain("Continue implementation")
    expect(result).toMatchObject({ content: expect.stringContaining("sess_new") })
  })

  test("builds a prompt when no files are supplied", async () => {
    const prompts: unknown[] = []
    const ctx = createCtx({
      session: {
        async create() {
          return { id: "sess_new" }
        },
        async prompt(input: unknown) {
          prompts.push(input)
        },
      },
    })

    await createHandoffSessionTool(ctx).execute(
      { prompt: "Continue implementation" },
      { sessionID: "sess_source" } as never
    )

    expect(prompts).toEqual([
      {
        sessionID: "sess_new",
        text: [
          "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.",
          "",
          "Continue implementation",
        ].join("\n"),
      },
    ])
  })
})

describe("ReadSession", () => {
  test("formats visible conversation content", async () => {
    const requests: unknown[] = []
    const ctx = createCtx({
      session: {
        async context(input: unknown) {
          requests.push(input)
          return [
            {
              type: "user",
              text: "hello",
              files: [{ uri: "file:///notes.txt", name: "notes.txt" }],
            },
            {
              type: "assistant",
              content: [
                { type: "text", text: "done" },
                { type: "tool", name: "read", state: { status: "completed" } },
                { type: "tool", name: "write", state: { status: "running" } },
              ],
            },
          ]
        },
      },
    })

    const result = await createReadSessionTool(ctx).execute({
      sessionID: "sess_old",
      limit: 2,
    })

    expect(requests).toEqual([{ sessionID: "sess_old" }])
    expect(result).toEqual({
      content: [
        "## User",
        "hello",
        "[Attached: notes.txt]",
        "",
        "## Assistant",
        "done",
        "[Tool: read] completed",
        "[Tool: write] running",
        "",
        "(Showing 2 most recent messages. Use a higher 'limit' to see more.)",
      ].join("\n"),
    })
  })

  test("applies the limit client-side and handles an empty session", async () => {
    const requests: unknown[] = []
    const ctx = createCtx({
      session: {
        async context(input: unknown) {
          requests.push(input)
          return []
        },
      },
    })

    const result = await createReadSessionTool(ctx).execute({
      sessionID: "sess_empty",
    })

    expect(requests).toEqual([{ sessionID: "sess_empty" }])
    expect(result).toEqual({
      content: "Session has no messages or does not exist.",
    })
  })

  test("keeps the most recent messages and turns client errors into useful output", async () => {
    const ctx = createCtx({
      session: {
        async context() {
          throw new Error("offline")
        },
      },
    })

    const failing = await createReadSessionTool(ctx).execute({
      sessionID: "sess_old",
      limit: 900,
    })
    expect(failing).toEqual({
      content: "Could not read session sess_old: offline",
    })

    const pagingCtx = createCtx({
      session: {
        async context() {
          return [
            { type: "user", text: "one" },
            { type: "user", text: "two" },
            { type: "user", text: "three" },
          ]
        },
      },
    })
    const paged = await createReadSessionTool(pagingCtx).execute({
      sessionID: "sess_old",
      limit: 2,
    })
    expect(paged).toEqual({
      content: [
        "## User",
        "two",
        "",
        "## User",
        "three",
        "",
        "(Showing 2 most recent messages. Use a higher 'limit' to see more.)",
      ].join("\n"),
    })
  })
})
