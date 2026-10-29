import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { HandoffSession, ReadSession, prepareHandoff, startHandoff } from "../src/tools"

type Context = Plugin.Context

function createContext(partial: Record<string, unknown>): Context {
  return partial as unknown as Context
}

const TOOL_CONTEXT = { sessionID: "sess_source", agent: "plan" } as never
const SOURCE_MODEL = { id: "model", providerID: "provider" }

function createHandoffContext(directory: string, options: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; input: unknown }> = []
  const ctx = createContext({
    location: { directory },
    options,
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
  test("attaches only selected files, with a manifest and the source agent and model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-tools-"))

    try {
      await writeFile(join(directory, "note.txt"), "handoff context")
      await writeFile(join(directory, "reference.txt"), "read this later")
      await writeFile(join(directory, "image.bin"), new Uint8Array([0, 1, 2]))

      const { ctx, calls } = createHandoffContext(directory)
      const text = [
        "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.",
        "Continue in @reference.txt",
        "## Files\n\nAttached files are preloaded. Read list-only files with tools if needed.\n\n" +
          "- `note.txt` (attached): immediate work\n" +
          "- `reference.txt` (list only): reference\n" +
          "- `image.bin` (list only: Binary file): image",
      ].join("\n\n")

      const result = await HandoffSession(ctx, (draft) => startHandoff(ctx, draft)).execute(
        {
          prompt: "Continue in @reference.txt",
          files: [
            { path: "note.txt", description: "immediate work", mode: "attach" },
            { path: "reference.txt", description: "reference", mode: "list" },
            { path: "image.bin", description: "image", mode: "attach" },
          ],
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
            ],
          },
        },
      ])
      expect(result.content).toBe("Started handoff session sess_new with 1 attached and 2 list-only file(s).")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("reports the reviewer's decision instead of starting the session itself", async () => {
    const { ctx, calls } = createHandoffContext("/tmp/project")
    const drafts: unknown[] = []

    const result = await HandoffSession(ctx, async (draft) => {
      drafts.push(draft)
      return { sessionID: "sess_reviewed", files: 1, listed: 2 }
    }).execute({ prompt: "Continue", files: [{ path: "src/a.ts", description: "alpha", mode: "attach" }] }, TOOL_CONTEXT)
    const cancelled = await HandoffSession(ctx, async () => ({ cancelled: true })).execute(
      { prompt: "Continue" },
      TOOL_CONTEXT
    )

    expect(drafts).toEqual([
      {
        sourceSessionID: "sess_source",
        agent: "plan",
        text: "Continue",
        files: [{ path: "src/a.ts", description: "alpha", mode: "attach" }],
      },
    ])
    expect(calls).toEqual([])
    expect(result.content).toBe("Started handoff session sess_reviewed with 1 attached and 2 list-only file(s).")
    expect(cancelled.content).toBe("The user cancelled the handoff.")
  })

  test("previews current content, keeps list-only content out of estimates, and enforces the opt-out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-estimate-"))
    try {
      await writeFile(join(directory, "a.txt"), "abcde")
      await writeFile(join(directory, "b.txt"), "x".repeat(10000))
      const options = { attachFiles: true }
      const { ctx, calls } = createHandoffContext(directory, options)
      const draft = { sourceSessionID: "sess_source", agent: "plan", text: "Continue", files: [
        { path: "a.txt", description: "alpha", mode: "attach" as const },
        { path: "b.txt", description: "beta", mode: "list" as const },
      ] }
      const initial = await prepareHandoff(ctx, draft)
      expect(initial.preview).toMatchObject({ attachmentTokens: 2, totalTokens: initial.preview.promptTokens + 2 })
      await writeFile(join(directory, "a.txt"), "a".repeat(21))
      expect((await prepareHandoff(ctx, draft)).preview.attachmentTokens).toBe(6)
      expect(await startHandoff(ctx, draft)).toEqual({ sessionID: "sess_new", files: 1, listed: 1 })
      options.attachFiles = false
      expect((await prepareHandoff(ctx, draft)).preview.attachmentTokens).toBe(0)
      expect(await startHandoff(ctx, draft)).toEqual({ sessionID: "sess_new", files: 0, listed: 2 })
      expect(calls.at(-1)).toMatchObject({ name: "prompt", input: { files: [] } })
      await rm(join(directory, "a.txt"))
      options.attachFiles = true
      expect((await prepareHandoff(ctx, draft)).preview).toMatchObject({ attachmentTokens: null, totalTokens: null })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
