import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { HandoffSession, ReadSession, startHandoff } from "../src/tools"

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
  test("starts the session with the manifest in the text and no attachments", async () => {
    const { ctx, calls } = createHandoffContext("/tmp/project")

    const result = await HandoffSession(ctx, (draft) => startHandoff(ctx, draft)).execute(
      {
        prompt: "Continue the work",
        files: [
          { path: "src/a.ts", description: "draft assembly:\n  buildFileManifest renders bullets" },
          { path: "@src/b.ts", description: "manifest counting" },
        ],
      },
      TOOL_CONTEXT
    )

    const text = [
      "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.",
      "Continue the work",
      [
        "## Files",
        "",
        "- `src/a.ts` — draft assembly: buildFileManifest renders bullets",
        "- `src/b.ts` — manifest counting",
      ].join("\n"),
    ].join("\n\n")

    expect(calls).toEqual([
      { name: "get", input: { sessionID: "sess_source" } },
      { name: "create", input: { agent: "plan", model: SOURCE_MODEL } },
      { name: "prompt", input: { sessionID: "sess_new", text } },
    ])
    expect(result.content).toBe(
      "Started handoff session sess_new with 2 listed file(s) — contents are not attached, the new session reads them itself."
    )
  })

  test("reports the reviewer's decision instead of starting the session itself", async () => {
    const { ctx, calls } = createHandoffContext("/tmp/project")
    const drafts: unknown[] = []

    const result = await HandoffSession(ctx, async (draft) => {
      drafts.push(draft)
      return { sessionID: "sess_reviewed", files: 2 }
    }).execute(
      { prompt: "Continue", files: [{ path: "src/a.ts", description: "alpha" }] },
      TOOL_CONTEXT
    )
    const cancelled = await HandoffSession(ctx, async () => ({ cancelled: true })).execute(
      { prompt: "Continue" },
      TOOL_CONTEXT
    )

    expect(drafts).toEqual([
      {
        sourceSessionID: "sess_source",
        agent: "plan",
        text:
          "Continuing work from session sess_source. When you lack specific information you can use read_session to get it." +
          "\n\nContinue\n\n## Files\n\n- `src/a.ts` — alpha",
      },
    ])
    expect(calls).toEqual([])
    expect(result.content).toBe(
      "Started handoff session sess_reviewed with 2 listed file(s) — contents are not attached, the new session reads them itself."
    )
    expect(cancelled.content).toBe("The user cancelled the handoff.")
  })

  test("demotes everything past the 10 most important files to other context", async () => {
    const { ctx, calls } = createHandoffContext("/tmp/project")
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `src/f${index + 1}.ts`,
      description: `file ${index + 1}`,
    }))

    const result = await HandoffSession(ctx, (draft) => startHandoff(ctx, draft)).execute(
      { prompt: "Continue the work", files },
      TOOL_CONTEXT
    )

    const text = [
      "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.",
      "Continue the work",
      [
        "## Files",
        "",
        ...Array.from({ length: 10 }, (_, index) => `- \`src/f${index + 1}.ts\` — file ${index + 1}`),
        "",
        "## Other context",
        "",
        "Listed for completeness; lower priority — read only if the main files leave a gap.",
        "",
        "- `src/f11.ts` — file 11",
        "- `src/f12.ts` — file 12",
      ].join("\n"),
    ].join("\n\n")

    expect(calls[2]!.input).toEqual({ sessionID: "sess_new", text })
    expect(result.content).toBe(
      "Started handoff session sess_new with 12 listed file(s) — contents are not attached, the new session reads them itself."
    )
  })

  test("omits the manifest and reports zero files when none are listed", async () => {
    const { ctx, calls } = createHandoffContext("/tmp/project")

    const result = await HandoffSession(ctx, (draft) => startHandoff(ctx, draft)).execute(
      { prompt: "Continue the work" },
      TOOL_CONTEXT
    )

    expect(calls[2]!.input).toEqual({
      sessionID: "sess_new",
      text: "Continuing work from session sess_source. When you lack specific information you can use read_session to get it.\n\nContinue the work",
    })
    expect(result.content).toBe(
      "Started handoff session sess_new with 0 listed file(s) — contents are not attached, the new session reads them itself."
    )
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
