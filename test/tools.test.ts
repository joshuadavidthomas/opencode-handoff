import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { HandoffSession, ReadSession, type OpencodeClient } from "../src/tools"

function createToolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "msg_test",
    agent: "build",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

describe("HandoffSession", () => {
  test("opens a new session with an editable handoff draft", async () => {
    const calls: Array<{ name: string; input: unknown }> = []
    const client = {
      tui: {
        async executeCommand(input: unknown) {
          calls.push({ name: "executeCommand", input })
        },
        async appendPrompt(input: unknown) {
          calls.push({ name: "appendPrompt", input })
        },
        async showToast(input: unknown) {
          calls.push({ name: "showToast", input })
        },
      },
    } as unknown as OpencodeClient

    const result = await HandoffSession(client).execute(
      {
        prompt: "Continue implementation",
        files: ["src/files.ts", "@README.md"],
      },
      createToolContext("sess_source")
    )

    expect(calls.map((call) => call.name)).toEqual([
      "executeCommand",
      "appendPrompt",
      "showToast",
    ])
    expect(calls[0]?.input).toEqual({ body: { command: "session_new" } })

    const appended = calls[1]?.input as { body: { text: string } }
    expect(appended.body.text).toContain("Continuing work from session sess_source")
    expect(appended.body.text).toContain("@src/files.ts @README.md")
    expect(appended.body.text).toContain("Continue implementation")
    expect(calls[2]?.input).toMatchObject({ body: { variant: "success" } })
    expect(result).toContain("Review and edit")
  })

  test("builds a draft when no files are supplied", async () => {
    const appendedPrompts: unknown[] = []
    const client = {
      tui: {
        async executeCommand() {},
        async appendPrompt(input: unknown) {
          appendedPrompts.push(input)
        },
        async showToast() {},
      },
    } as unknown as OpencodeClient

    await HandoffSession(client).execute(
      { prompt: "Continue implementation" },
      createToolContext("sess_source")
    )

    expect(appendedPrompts).toEqual([
      {
        body: {
          text: [
            "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.",
            "",
            "Continue implementation",
          ].join("\n"),
        },
      },
    ])
  })
})

describe("ReadSession", () => {
  test("formats visible conversation content", async () => {
    const requests: unknown[] = []
    const client = {
      session: {
        async messages(input: unknown) {
          requests.push(input)
          return {
            data: [
              {
                info: { role: "user" },
                parts: [
                  { type: "text", text: "hello" },
                  { type: "text", text: "hidden", ignored: true },
                  { type: "file", filename: "notes.txt" },
                ],
              },
              {
                info: { role: "assistant" },
                parts: [
                  { type: "text", text: "done" },
                  {
                    type: "tool",
                    tool: "read",
                    state: { status: "completed", title: "Read file" },
                  },
                  {
                    type: "tool",
                    tool: "write",
                    state: { status: "running", title: "Writing" },
                  },
                ],
              },
            ],
          }
        },
      },
    } as unknown as OpencodeClient

    const result = await ReadSession(client).execute(
      { sessionID: "sess_old", limit: 2 },
      createToolContext("sess_current")
    )

    expect(requests).toEqual([
      { path: { id: "sess_old" }, query: { limit: 2 } },
    ])
    expect(result).toBe(
      [
        "## User",
        "hello",
        "[Attached: notes.txt]",
        "",
        "## Assistant",
        "done",
        "[Tool: read] Read file",
        "",
        "(Showing 2 most recent messages. Use a higher 'limit' to see more.)",
      ].join("\n")
    )
  })

  test("uses the default limit and handles an empty session", async () => {
    const requests: unknown[] = []
    const client = {
      session: {
        async messages(input: unknown) {
          requests.push(input)
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    const result = await ReadSession(client).execute(
      { sessionID: "sess_empty" },
      createToolContext("sess_current")
    )

    expect(requests).toEqual([
      { path: { id: "sess_empty" }, query: { limit: 100 } },
    ])
    expect(result).toBe("Session has no messages or does not exist.")
  })

  test("caps the limit and turns client errors into useful output", async () => {
    const requests: unknown[] = []
    const client = {
      session: {
        async messages(input: unknown) {
          requests.push(input)
          throw new Error("offline")
        },
      },
    } as unknown as OpencodeClient

    const result = await ReadSession(client).execute(
      { sessionID: "sess_old", limit: 900 },
      createToolContext("sess_current")
    )

    expect(requests).toEqual([
      { path: { id: "sess_old" }, query: { limit: 500 } },
    ])
    expect(result).toBe("Could not read session sess_old: offline")
  })
})
