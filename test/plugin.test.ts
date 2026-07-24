import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HandoffPlugin } from "../src/plugin"
import type { OpencodeClient } from "../src/tools"

function createPluginInput(
  directory: string,
  client: OpencodeClient
): PluginInput {
  return {
    client,
    directory,
    worktree: directory,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: {},
  } as unknown as PluginInput
}

describe("HandoffPlugin", () => {
  test("registers the handoff command and tools", async () => {
    const client = {} as OpencodeClient
    const hooks = await HandoffPlugin(createPluginInput("/tmp/project", client))
    const freshConfig: {
      command?: Record<string, { description: string; template: string }>
    } = {}
    await hooks.config!(freshConfig as never)
    expect(freshConfig.command?.handoff).toBeDefined()

    const config: {
      command: Record<string, { description: string; template: string }>
    } = {
      command: {
        existing: { description: "Existing command", template: "keep me" },
      },
    }
    await hooks.config!(config as never)

    expect(config.command.existing).toEqual({
      description: "Existing command",
      template: "keep me",
    })
    expect(config.command.handoff?.template).toContain("USER: $ARGUMENTS")
    expect(hooks.tool?.handoff_session).toBeDefined()
    expect(hooks.tool?.read_session).toBeDefined()
  })

  test("injects referenced files once and resets after session deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-plugin-"))

    try {
      await writeFile(join(directory, "note.txt"), "handoff context")
      const promptCalls: unknown[] = []
      const client = {
        session: {
          async prompt(input: unknown) {
            promptCalls.push(input)
          },
        },
      } as unknown as OpencodeClient
      const hooks = await HandoffPlugin(createPluginInput(directory, client))
      const message = {
        message: {
          sessionID: "sess_next",
          model: { providerID: "provider", modelID: "model" },
          agent: "build",
        },
        parts: [
          {
            type: "text",
            synthetic: true,
            text: "Continuing work from session ignored @missing.txt",
          },
          {
            type: "text",
            text: "Continuing work from session sess_source @note.txt",
          },
        ],
      }

      await hooks["chat.message"]!(
        { sessionID: "sess_next" } as never,
        {
          message: message.message,
          parts: [{ type: "text", text: "ordinary message @note.txt" }],
        } as never
      )
      expect(promptCalls).toHaveLength(0)

      await hooks["chat.message"]!(
        { sessionID: "sess_next" } as never,
        message as never
      )
      await hooks["chat.message"]!(
        { sessionID: "sess_next" } as never,
        message as never
      )

      expect(promptCalls).toHaveLength(1)
      const promptCall = promptCalls[0] as {
        path: { id: string }
        body: {
          noReply: boolean
          model: unknown
          agent: string
          parts: Array<{ synthetic?: boolean; text: string }>
        }
      }
      expect(promptCall).toMatchObject({
        path: { id: "sess_next" },
        body: {
          noReply: true,
          model: { providerID: "provider", modelID: "model" },
          agent: "build",
        },
      })
      expect(promptCall.body.parts).toHaveLength(2)
      expect(promptCall.body.parts.every((part) => part.synthetic)).toBe(true)
      expect(promptCall.body.parts.map((part) => part.text).join("\n")).toContain(
        "handoff context"
      )
      expect(promptCall.body.parts.map((part) => part.text).join("\n")).not.toContain(
        "missing.txt"
      )

      await hooks.event!({
        event: {
          type: "session.deleted",
          properties: { info: { id: "sess_next" } },
        },
      } as never)
      await hooks["chat.message"]!(
        { sessionID: "sess_next" } as never,
        message as never
      )

      expect(promptCalls).toHaveLength(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
