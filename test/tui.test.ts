import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import HandoffTui from "../tui"

const LOCATION = { directory: "/tmp/project" }

type Listener = (event: unknown) => Promise<void> | void

function createTui(options: { route: unknown; tabs?: Array<{ sessionID: string }>; claimed?: boolean }) {
  const calls: unknown[] = []
  const listeners: Record<string, Listener> = {}
  let onClose: (() => void) | undefined
  const context = {
    client: {
      rpc: (definition: { id: string }) => ({
        events: {
          on(name: string, listener: Listener) {
            expect(definition.id).toBe("opencode-handoff")
            listeners[name] = listener
            return () => {}
          },
        },
        async claim(input: unknown, requestOptions: unknown) {
          calls.push({ claim: input, ...(requestOptions as object) })
          return { claimed: options.claimed ?? true }
        },
        async cancel(input: unknown, requestOptions: unknown) {
          calls.push({ cancel: input, ...(requestOptions as object) })
          return {}
        },
      }),
    },
    keymap: { shortcuts: () => [] },
    theme: { surface: () => ({}) },
    renderer: { height: 40 },
    ui: {
      router: {
        current: () => options.route,
        navigate: (destination: unknown) => calls.push({ navigate: destination }),
      },
      toast: { show: (toast: unknown) => calls.push({ toast }) },
      tabs: { list: () => options.tabs ?? [] },
      dialog: {
        show(_render: unknown, close: () => void) {
          calls.push("show")
          onClose = close
        },
        set(dialogOptions: unknown) {
          calls.push({ set: dialogOptions })
        },
      },
    },
  } as unknown as Plugin.Context

  HandoffTui.setup(context)
  return { calls, listeners, close: () => onClose?.() }
}

async function setupTui(options: Parameters<typeof createTui>[0]) {
  const tui = createTui(options)
  await tui.listeners.draft!({
    location: LOCATION,
    data: { draftID: "draft_1", sourceSessionID: "sess_source", text: "Continue" },
  })
  return tui
}

async function started(options: Parameters<typeof createTui>[0]) {
  const tui = createTui(options)
  await tui.listeners.started!({ location: LOCATION, data: { sessionID: "sess_new", sourceSessionID: "sess_source" } })
  return tui.calls
}

describe("HandoffTui", () => {
  test("the client showing the source session claims the draft and opens the editor", async () => {
    const { calls, close } = await setupTui({ route: { type: "session", sessionID: "sess_source" } })

    expect(calls).toEqual([
      { claim: { draftID: "draft_1" }, location: LOCATION },
      "show",
      { set: { size: "xlarge", centered: true } },
    ])

    close()
    expect(calls.at(-1)).toEqual({ cancel: { draftID: "draft_1" }, location: LOCATION })
  })

  test("a client with the source session in a background tab also claims it", async () => {
    const { calls } = await setupTui({ route: { type: "home" }, tabs: [{ sessionID: "sess_source" }] })

    expect(calls[0]).toEqual({ claim: { draftID: "draft_1" }, location: LOCATION })
    expect(calls).toContain("show")
  })

  test("does not open the editor when another client claimed the draft first", async () => {
    const { calls } = await setupTui({ route: { type: "session", sessionID: "sess_source" }, claimed: false })

    expect(calls).toEqual([{ claim: { draftID: "draft_1" }, location: LOCATION }])
  })

  test("leaves drafts from sessions this client doesn't have open alone", async () => {
    const { calls } = await setupTui({ route: { type: "session", sessionID: "sess_other" }, tabs: [{ sessionID: "sess_other" }] })

    expect(calls).toEqual([])
  })

  test("a handoff started without review switches the client showing the source session", async () => {
    expect(await started({ route: { type: "session", sessionID: "sess_source" } })).toEqual([
      { navigate: { type: "session", sessionID: "sess_new" } },
      { toast: { message: "Handoff started", variant: "success" } },
    ])
    expect(await started({ route: { type: "home" }, tabs: [{ sessionID: "sess_source" }] })).toEqual([
      { toast: { message: "Handoff started", variant: "success", sessionID: "sess_new" } },
    ])
    expect(await started({ route: { type: "session", sessionID: "sess_other" } })).toEqual([])
  })
})
