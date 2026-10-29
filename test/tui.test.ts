import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { render, type JSX } from "@opentui/solid"
import { createTestRenderer } from "@opentui/core/testing"
import { createComponent, createSignal, Show } from "solid-js"
import type { DialogSelectOptions, KeymapLayer } from "@opencode/plugin/tui/context"
import type { HandoffFile, HandoffPreview } from "../src/rpc"
import HandoffTui from "../tui"

const LOCATION = { directory: "/tmp/project" }

type Listener = (event: unknown) => Promise<void> | void

function createTui(options: {
  route: unknown
  tabs?: Array<{ sessionID: string }>
  claimed?: boolean
  claim?: (input: { draftID: string }) => Promise<{ claimed: boolean }>
  renderer?: Plugin.Context["renderer"]
  preview?: (input: { text: string; files: HandoffFile[] }) => Promise<HandoffPreview>
}) {
  const calls: unknown[] = []
  const listeners: Record<string, Listener> = {}
  const layers: Array<() => KeymapLayer> = []
  const [draw, setDraw] = createSignal<() => JSX.Element>(() => undefined)
  let picker: DialogSelectOptions<string> | undefined
  let chooseFile: (path?: string) => void = () => {}
  let onClose: (() => void) | undefined
  const context = {
    client: {
      file: { find: async () => ({ data: [{ path: "test/a.test.ts", type: "file" }] }) },
      rpc: (definition: { id: string }) => ({
        events: {
          on(name: string, listener: Listener) {
            expect(definition.id).toBe("opencode-handoff")
            listeners[name] = listener
            return () => {}
          },
        },
        async claim(input: { draftID: string }, requestOptions: unknown) {
          calls.push({ claim: input, ...(requestOptions as object) })
          return options.claim ? options.claim(input) : { claimed: options.claimed ?? true }
        },
        async cancel(input: unknown, requestOptions: unknown) {
          calls.push({ cancel: input, ...(requestOptions as object) })
          return {}
        },
        async start(input: unknown, requestOptions: unknown) {
          calls.push({ start: input, ...(requestOptions as object) })
          return { sessionID: "sess_new" }
        },
        preview: options.preview,
      }),
    },
    keymap: { shortcuts: () => [], layer: (factory: () => KeymapLayer) => layers.push(factory) },
    theme: { surface: () => ({
      text: { base: "#e2e8f0", muted: "#94a3b8", formfield: { base: "#e2e8f0" }, action: { primary: { focused: "#111827" }, destructive: {
        state: ({ hovered }: { hovered: boolean }) => hovered ? "#ffffff" : "#94a3b8",
      } } },
      background: { raised: { high: "#1e293b" }, action: { primary: { focused: "#f59e0b" }, destructive: {
        state: ({ hovered }: { hovered: boolean }) => hovered ? "#be123c" : "#334155",
      } } },
    }) },
    renderer: options.renderer ?? { height: 40, width: 120 },
    ui: {
      router: {
        current: () => options.route,
        navigate: (destination: unknown) => calls.push({ navigate: destination }),
      },
      toast: { show: (toast: unknown) => calls.push({ toast }) },
      tabs: { list: () => options.tabs ?? [] },
      dialog: {
        show(render: () => JSX.Element, close: () => void) {
          onClose?.()
          calls.push("show")
          setDraw(() => render)
          onClose = close
        },
        clear() { onClose?.(); onClose = undefined; setDraw(() => () => undefined) },
        select(options: DialogSelectOptions<string>) {
          onClose?.()
          setDraw(() => () => undefined)
          picker = options
          return new Promise<string | undefined>((resolve) => {
            chooseFile = resolve
            onClose = () => { picker = undefined; resolve(undefined) }
          })
        },
        set(dialogOptions: unknown) {
          calls.push({ set: dialogOptions })
        },
      },
    },
  } as unknown as Plugin.Context

  const cleanup = HandoffTui.setup(context)
  return {
    calls, listeners, close: () => onClose?.(),
    dispose: async () => { const stop = await cleanup; stop?.() },
    draw: () => createComponent(Show, { get when() { return draw() }, keyed: true, children: (render: () => JSX.Element) => render() }),
    replaceDialog: () => context.ui.dialog.show(() => undefined, () => { calls.push("replacement closed") }),
    chooseFile: (path?: string) => chooseFile(path),
    searchFiles: (query: string) => picker?.search?.(query, picker.options) ?? [],
    async command(bind: string) {
      if (picker) {
        const action = picker.actions?.find((action) => action.bind === bind)
        if (action?.selection === "none") action.onTrigger()
        return
      }
      const command = layers.at(-1)?.().commands?.find((command) => command.bind === bind)
      if (command && command.enabled !== false) await command.run()
    },
  }
}

async function setupTui(options: Parameters<typeof createTui>[0]) {
  const tui = createTui(options)
  await tui.listeners.draft!({
    location: LOCATION,
    data: { draftID: "draft_1", sourceSessionID: "sess_source", text: "Continue", files: [], attachFiles: true },
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

  test("a client with the source session only in a background tab leaves the draft alone", async () => {
    const { calls } = await setupTui({ route: { type: "home" }, tabs: [{ sessionID: "sess_source" }] })

    expect(calls).toEqual([])
  })

  test("does not open the editor when another client claimed the draft first", async () => {
    const { calls } = await setupTui({ route: { type: "session", sessionID: "sess_source" }, claimed: false })

    expect(calls).toEqual([{ claim: { draftID: "draft_1" }, location: LOCATION }])
  })

  test("a claim completing after disposal cancels the draft without opening a review", async () => {
    const claim = Promise.withResolvers<{ claimed: boolean }>()
    const tui = createTui({ route: { type: "session", sessionID: "sess_source" }, claim: () => claim.promise })
    const pending = tui.listeners.draft!({ location: LOCATION, data: {
      draftID: "draft_1", sourceSessionID: "sess_source", text: "Continue", files: [], attachFiles: true,
    } })
    await tui.dispose()
    claim.resolve({ claimed: true })
    await pending

    expect(tui.calls).toEqual([
      { claim: { draftID: "draft_1" }, location: LOCATION },
      { cancel: { draftID: "draft_1" }, location: LOCATION },
    ])
  })

  test("leaves drafts from sessions this client doesn't have open alone", async () => {
    const { calls } = await setupTui({ route: { type: "session", sessionID: "sess_other" }, tabs: [{ sessionID: "sess_other" }] })

    expect(calls).toEqual([])
  })

  test("a draft arriving during file selection replaces and cancels only the old draft", async () => {
    const terminal = await createTestRenderer({ width: 100, height: 40 })
    const tui = await setupTui({ route: { type: "session", sessionID: "sess_source" }, renderer: terminal.renderer })
    try {
      await render(tui.draw, terminal.renderer)
      await tui.command("ctrl+f")
      const picking = tui.command("ctrl+a")
      await tui.listeners.draft!({ location: LOCATION, data: {
        draftID: "draft_2", sourceSessionID: "sess_source", text: "New handoff", files: [], attachFiles: true,
      } })
      await picking
      await terminal.renderOnce()
      expect(terminal.captureCharFrame()).toContain("New handoff")
      expect(tui.calls).toContainEqual({ cancel: { draftID: "draft_1" }, location: LOCATION })
      expect(tui.calls).not.toContainEqual({ cancel: { draftID: "draft_2" }, location: LOCATION })
      await tui.command("ctrl+s")
      expect(tui.calls).toContainEqual({ start: { draftID: "draft_2", text: "New handoff", files: [] }, location: LOCATION })
    } finally {
      await terminal.dispose()
    }
  })

  test("returning and reopening the picker before it settles keeps the handoff active", async () => {
    const terminal = await createTestRenderer({ width: 100, height: 40 })
    const tui = await setupTui({ route: { type: "session", sessionID: "sess_source" }, renderer: terminal.renderer })
    try {
      await render(tui.draw, terminal.renderer)
      await tui.command("ctrl+f")
      const first = tui.command("ctrl+a")
      const back = tui.command("escape")
      const second = tui.command("ctrl+a")
      await back
      await first
      tui.chooseFile("test/a.test.ts")
      await second
      await terminal.renderOnce()

      expect(tui.calls).not.toContainEqual({ cancel: { draftID: "draft_1" }, location: LOCATION })
      expect(terminal.captureCharFrame()).toContain("Continue")
      expect(terminal.captureCharFrame()).toContain("test/a.test.ts")
      await tui.command("ctrl+s")
      expect(tui.calls).toContainEqual({ start: {
        draftID: "draft_1", text: "Continue", files: [{ path: "test/a.test.ts", description: "", mode: "attach" }],
      }, location: LOCATION })
    } finally {
      await tui.dispose()
      await terminal.dispose()
    }
  })

  test("a host dialog replacing the picker stays open and cancels the handoff", async () => {
    const terminal = await createTestRenderer({ width: 100, height: 40 })
    const tui = await setupTui({ route: { type: "session", sessionID: "sess_source" }, renderer: terminal.renderer })
    try {
      await render(tui.draw, terminal.renderer)
      await tui.command("ctrl+f")
      const picking = tui.command("ctrl+a")
      tui.replaceDialog()
      await picking
      await terminal.renderOnce()
      expect(tui.calls).not.toContain("replacement closed")
      expect(terminal.captureCharFrame()).not.toContain("Review handoff")
      expect(tui.calls).toContainEqual({ cancel: { draftID: "draft_1" }, location: LOCATION })
      tui.close()
      expect(tui.calls.at(-1)).toBe("replacement closed")
    } finally {
      await terminal.dispose()
    }
  })

  test("dismissing the picker without Back cancels instead of reopening the review", async () => {
    const terminal = await createTestRenderer({ width: 100, height: 40 })
    const tui = await setupTui({ route: { type: "session", sessionID: "sess_source" }, renderer: terminal.renderer })
    try {
      await render(tui.draw, terminal.renderer)
      await tui.command("ctrl+f")
      const picking = tui.command("ctrl+a")
      tui.close()
      await picking
      await terminal.renderOnce()
      expect(terminal.captureCharFrame()).not.toContain("Review handoff")
      expect(tui.calls).toContainEqual({ cancel: { draftID: "draft_1" }, location: LOCATION })
    } finally {
      await terminal.dispose()
    }
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

  test.each([{ width: 140, height: 42 }, { width: 100, height: 40 }, { width: 80, height: 24 }])("reviews files below the summary, edits choices, and sends at %j", async ({ width, height }) => {
    const terminal = await createTestRenderer({ width, height })
    const implementationPath = "src/components/handoff/review-file-selection-panel.tsx"
    const initialFiles: HandoffFile[] = [
      { path: implementationPath, description: "implementation", mode: "attach" },
      { path: "README.md", description: "reference", mode: "list" },
    ]
    const tui = createTui({
      route: { type: "session", sessionID: "sess_source" },
      renderer: terminal.renderer,
      preview: async ({ files }) => ({
        files: files.map((file) => ({ ...file, attachment: file.mode === "attach" ? { tokens: 17 } : null })),
        promptTokens: 50,
        attachmentTokens: files.filter((file) => file.mode === "attach").length * 17,
        totalTokens: 50 + files.filter((file) => file.mode === "attach").length * 17,
      }),
    })
    await tui.listeners.draft!({ location: LOCATION, data: {
      draftID: "draft_1", sourceSessionID: "sess_source", text: "Continue", files: initialFiles, attachFiles: true,
    } })
    try {
      await render(tui.draw, terminal.renderer)
      await Bun.sleep(250)
      await terminal.renderOnce()
      const initialFrame = terminal.captureCharFrame()
      expect(initialFrame).toContain("Prompt ~50 + file contents ~17 = ~67 tokens")
      const initialLines = initialFrame.split("\n")
      const fileRow = initialLines.find((line) => line.includes(implementationPath))
      expect(fileRow).toContain("Include")
      expect(fileRow).toContain("~17")
      expect(fileRow?.trimStart().startsWith(`[x] ${implementationPath}`)).toBe(true)
      expect(fileRow!.indexOf("~17")).toBeLessThan(fileRow!.indexOf("Include"))
      expect(initialLines.findIndex((line) => line.includes("Files"))).toBeGreaterThan(initialLines.findIndex((line) => line.includes("Continue")))
      expect(initialFrame).toContain("README.md")
      expect(initialFrame).toContain("Omit")
      expect(initialFrame).toContain("Contents")
      expect(initialFrame).not.toContain("reference")
      expect(initialFrame).not.toContain("Content tokens")
      expect(initialFrame).not.toContain("Full file")
      expect(initialFrame).not.toContain("Path only")
      expect(initialFrame).not.toContain("Note:")
      expect(initialFrame).not.toContain("implementation")
      expect(initialFrame).not.toContain("·")
      await terminal.mockInput.typeText("Revised. ")
      await tui.command("ctrl+f")
      await Bun.sleep(250)
      await terminal.renderOnce()
      const lines = terminal.captureCharFrame().split("\n")
      expect(lines.join("\n")).toContain("Revised. Continue")
      const row = lines.findIndex((line) => line.includes(implementationPath))
      await terminal.mockMouse.click(lines[row]!.indexOf("Include") + 1, row)
      await Bun.sleep(250)
      await terminal.renderOnce()
      expect(terminal.captureCharFrame()).toContain("Prompt ~50 + file contents ~0 = ~50 tokens")
      expect(terminal.captureCharFrame()).not.toContain("implementation")
      await tui.command("space")
      await terminal.renderOnce()
      expect(terminal.captureCharFrame().split("\n").find((line) => line.includes(implementationPath))).toContain("Include")
      await tui.command("space")
      await terminal.renderOnce()
      const beforeRemove = terminal.captureCharFrame().split("\n")
      const removeRow = beforeRemove.findIndex((line) => line.includes("README.md"))
      const removeColumn = beforeRemove[removeRow]!.indexOf("[x]")
      await terminal.mockMouse.moveTo(removeColumn + 1, removeRow)
      await terminal.renderOnce()
      expect(terminal.captureSpans().lines[removeRow]!.spans.find((span) => span.text.includes("[x]"))!.bg.toInts()).toEqual([190, 18, 60, 255])
      await terminal.mockMouse.moveTo(removeColumn + 5, removeRow)
      await terminal.renderOnce()
      expect(terminal.captureSpans().lines[removeRow]!.spans.find((span) => span.text.includes("[x]"))!.bg.toInts()).toEqual([51, 65, 85, 255])
      await terminal.mockMouse.click(removeColumn, removeRow)
      await terminal.renderOnce()
      expect(terminal.captureCharFrame()).not.toContain("README.md")
      expect(terminal.captureCharFrame()).toContain(implementationPath)
      const cancelledPicker = tui.command("ctrl+a")
      await tui.command("escape")
      await cancelledPicker
      await terminal.renderOnce()
      expect(terminal.captureCharFrame()).toContain("Revised. Continue")
      expect(terminal.captureCharFrame()).not.toContain("README.md")
      expect(tui.calls).not.toContainEqual({ cancel: { draftID: "draft_1" }, location: LOCATION })
      const picking = tui.command("ctrl+a")
      tui.searchFiles("a.test")
      await Bun.sleep(150)
      expect(tui.searchFiles("a.test")).toEqual([{ title: "test/a.test.ts", value: "test/a.test.ts" }])
      tui.chooseFile("test/a.test.ts")
      await picking
      await terminal.renderOnce()
      expect(terminal.captureCharFrame()).toContain("test/a.test.ts")
      await tui.command("escape")
      await terminal.renderOnce()
      expect(terminal.captureCharFrame()).toContain("Review handoff")
      expect(terminal.captureCharFrame()).toContain("Revised. Continue")
      expect(tui.calls).not.toContainEqual({ cancel: { draftID: "draft_1" }, location: LOCATION })
      await terminal.mockInput.typeText("Kept. ")
      await tui.command("ctrl+s")
      expect(tui.calls).toContainEqual({ start: {
        draftID: "draft_1", text: "Revised. Kept. Continue", files: [
          { path: implementationPath, description: "implementation", mode: "list" },
          { path: "test/a.test.ts", description: "", mode: "attach" },
        ],
      }, location: LOCATION })
    } finally {
      await terminal.dispose()
    }
  })

  test.each([{ width: 140, height: 42 }, { width: 80, height: 24 }])("scrolls a long file list without moving totals or hiding actions at %j", async ({ width, height }) => {
    const terminal = await createTestRenderer({ width, height })
    const files: HandoffFile[] = Array.from({ length: 35 }, (_, index) => ({
      path: `src/file-${index}.ts`, description: "Supporting reference", mode: index === 0 ? "attach" : "list",
    }))
    const tui = createTui({
      route: { type: "session", sessionID: "sess_source" }, renderer: terminal.renderer,
      preview: async () => ({
        files: files.map((file) => ({ ...file, attachment: file.mode === "attach" ? { tokens: 2345678 } : null })),
        promptTokens: 1234567, attachmentTokens: 2345678, totalTokens: 3580245,
      }),
    })
    await tui.listeners.draft!({ location: LOCATION, data: {
      draftID: "draft_1", sourceSessionID: "sess_source", text: "Continue", files, attachFiles: true,
    } })
    try {
      await render(tui.draw, terminal.renderer)
      await Bun.sleep(250)
      await terminal.renderOnce()
      const initial = terminal.captureCharFrame().split("\n")
      const totalRow = initial.findIndex((line) => line.includes("Prompt ~1,234,567 + file contents ~2,345,678 = ~3,580,245 tokens"))
      expect(totalRow).toBeGreaterThan(0)
      const header = initial.find((line) => line.includes("Tokens"))!
      const firstFile = initial.find((line) => line.includes("src/file-0.ts"))!
      expect(header.indexOf("Contents")).toBe(firstFile.indexOf("Include"))
      expect(header.indexOf("Tokens")).toBe(firstFile.indexOf("~2,345,678"))
      expect(initial.join("\n")).toContain("Prompt ~1,234,567 + file contents ~2,345,678")
      expect(initial.join("\n")).not.toContain("src/file-34.ts")
      await tui.command("ctrl+f")
      await terminal.renderOnce()
      const rowBackground = (name: string) => terminal.captureSpans().lines
        .flatMap((line) => line.spans).find((span) => span.text.includes(name))!.bg.toInts()
      const selectedBackground = rowBackground("src/file-0.ts")
      const unselectedBackground = rowBackground("src/file-1.ts")
      expect(selectedBackground).not.toEqual(unselectedBackground)
      await tui.command("down")
      await terminal.renderOnce()
      expect(rowBackground("src/file-0.ts")).toEqual(unselectedBackground)
      expect(rowBackground("src/file-1.ts")).toEqual(selectedBackground)
      for (let index = 1; index < 34; index++) await tui.command("down")
      await terminal.renderOnce()
      const scrolled = terminal.captureCharFrame().split("\n")
      expect(scrolled.join("\n")).toContain("src/file-34.ts")
      expect(scrolled.findIndex((line) => line.includes("Prompt ~1,234,567 + file contents ~2,345,678 = ~3,580,245 tokens"))).toBe(totalRow)
      expect(scrolled.join("\n")).toContain("35 files")
      expect(scrolled.join("\n").toLowerCase()).toContain("scroll for more")
      expect(scrolled.join("\n")).toContain("Attach file ctrl+a")
      expect(scrolled.join("\n")).toContain("Exclude all file contents ctrl+l")
      expect(scrolled.join("\n")).toContain("send ctrl+s")
      expect(initial.findIndex((line) => line.includes("Files"))).toBeGreaterThan(initial.findIndex((line) => line.includes("Continue")))
    } finally {
      await terminal.dispose()
    }
  })

  test.each([true, false])("ignores stale estimates and respects attachFiles=%s", async (attachFiles) => {
    const terminal = await createTestRenderer({ width: 120, height: 40 })
    let resolveFirst: (value: HandoffPreview) => void = () => {}
    let requests = 0
    const first = new Promise<HandoffPreview>((resolve) => { resolveFirst = resolve })
    const files: HandoffFile[] = [{ path: "a.ts", description: "alpha", mode: attachFiles ? "attach" : "list" }]
    const tui = createTui({
      route: { type: "session", sessionID: "sess_source" },
      renderer: terminal.renderer,
      preview: async ({ files }) => {
        if (++requests === 1) return first
        return { files: files.map((file) => ({ ...file, attachment: null })), promptTokens: 50, attachmentTokens: 0, totalTokens: 50 }
      },
    })
    await tui.listeners.draft!({ location: LOCATION, data: {
      draftID: "draft_1", sourceSessionID: "sess_source", text: "Continue", files, attachFiles,
    } })
    try {
      await render(tui.draw, terminal.renderer)
      await Bun.sleep(250)
      await tui.command("ctrl+f")
      await tui.command("ctrl+l")
      await Bun.sleep(250)
      resolveFirst({ files: files.map((file) => ({ ...file, attachment: { tokens: 949 } })), promptTokens: 50, attachmentTokens: 949, totalTokens: 999 })
      await Promise.resolve()
      if (!attachFiles) {
        await tui.command("space")
      }
      await terminal.renderOnce()
      const frame = terminal.captureCharFrame()
      expect(frame).toContain("Prompt ~50 + file contents ~0 = ~50 tokens")
      expect(frame).toContain("Omit")
      if (!attachFiles) expect(frame).toContain("Attachments disabled in config")
      await tui.command("ctrl+s")
      expect(tui.calls).toContainEqual({ start: {
        draftID: "draft_1", text: "Continue", files: [{ path: "a.ts", description: "alpha", mode: "list" }],
      }, location: LOCATION })
    } finally {
      await terminal.dispose()
    }
  })
})
