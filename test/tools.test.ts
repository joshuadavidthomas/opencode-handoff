import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { HandoffSession, ReadSession } from "../src/tools"

type Context = Plugin.Context

function createContext(partial: Record<string, unknown>): Context {
  return partial as unknown as Context
}

const TOOL_CONTEXT = { sessionID: "sess_source" } as never

describe("HandoffSession", () => {
  test("starts a new session with the handoff prompt and attached files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-tools-"))

    try {
      await writeFile(join(directory, "note.txt"), "handoff context")

      const calls: Array<{ name: string; input: unknown }> = []
      const ctx = createContext({
        location: { directory },
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

      const result = await HandoffSession(ctx).execute(
        {
          prompt: "Continue implementation",
          files: ["note.txt", "@README.md"],
        },
        TOOL_CONTEXT
      )

      expect(calls.map((call) => call.name)).toEqual(["create", "prompt"])

      const promptCall = calls[1]?.input as {
        sessionID: string
        text: string
        files: Array<{ uri: string; name: string }>
      }
      expect(promptCall.sessionID).toBe("sess_new")
      expect(promptCall.text).toContain(
        "Continuing work from session sess_source"
      )
      // Files ride as attachments only. Naming them again as @refs in the text
      // duplicated the content and tripped the new session's compaction.
      expect(promptCall.text).not.toContain("@")
      expect(promptCall.text).toContain("Continue implementation")
      // README.md does not exist in the temp directory and is skipped
      expect(promptCall.files).toEqual([
        {
          uri: pathToFileURL(join(directory, "note.txt")).href,
          name: "note.txt",
        },
      ])

      expect(result.content).toContain("sess_new")
      expect(result.content).toContain("1 attached file(s)")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("creates the session without attachments when no files are supplied", async () => {
    const prompts: unknown[] = []
    const ctx = createContext({
      location: { directory: "/tmp/project" },
      session: {
        async create() {
          return { id: "sess_new" }
        },
        async prompt(input: unknown) {
          prompts.push(input)
        },
      },
    })

    await HandoffSession(ctx).execute(
      { prompt: "Continue implementation" },
      TOOL_CONTEXT
    )

    expect(prompts).toEqual([
      {
        sessionID: "sess_new",
        text: [
          "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.",
          "",
          "Continue implementation",
        ].join("\n"),
        files: [],
      },
    ])
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
    })

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
  })

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

    const result = await ReadSession(ctx).execute({ sessionID: "sess_empty" })

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
    })
    // 900 is capped to 500, but only 3 messages exist: nothing is truncated
    expect(result.content).toContain("(End of session - 3 messages)")

    const capped = await ReadSession(ctx).execute({
      sessionID: "sess_old",
      limit: 2,
    })
    expect(capped.content).not.toContain("first")
    expect(capped.content).toContain("second")
    expect(capped.content).toContain("third")
    expect(capped.content).toContain(
      "(Showing 2 most recent messages. Use a higher 'limit' to see more.)"
    )
  })

  test("turns client errors into useful output", async () => {
    const ctx = createContext({
      session: {
        async context() {
          throw new Error("offline")
        },
      },
    })

    const result = await ReadSession(ctx).execute({ sessionID: "sess_old" })

    expect(result.content).toBe("Could not read session sess_old: offline")
  })
})
