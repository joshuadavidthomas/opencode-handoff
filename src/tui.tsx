/** @jsxImportSource @opentui/solid */
import { TextAttributes, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { Plugin } from "@opencode/plugin/tui"
import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Handoff, type HandoffFile, type HandoffPreview } from "./rpc"

/**
 * Shows a handoff draft for editing before it is sent, and switches to a
 * handoff session started without review. Only a TUI showing the source
 * session claims a draft; TUIs on the same machine share tabs, so a tab is
 * no sign that this client ran the handoff.
 */
export default Plugin.define({
  id: "opencode-handoff-tui",
  setup(context) {
    const handoff = context.client.rpc(Handoff)
    let dismissReview: (() => void) | undefined
    let disposed = false

    const showing = (sessionID: string) => {
      const route = context.ui.router.current()
      return route.type === "session" && route.sessionID === sessionID
    }
    const open = (sessionID: string) => context.ui.tabs.list().some((tab) => tab.sessionID === sessionID)

    const stopStarted = handoff.events.on("started", (event) => {
      const { sessionID, sourceSessionID } = event.data as { sessionID: string; sourceSessionID: string }
      if (showing(sourceSessionID)) {
        context.ui.router.navigate({ type: "session", sessionID })
        context.ui.toast.show({ message: "Handoff started", variant: "success" })
      } else if (open(sourceSessionID)) {
        context.ui.toast.show({ message: "Handoff started", variant: "success", sessionID })
      }
    })

    const stopDraft = handoff.events.on("draft", async (event) => {
      const { draftID, sourceSessionID, text, files: initialFiles, attachFiles } = event.data as {
        draftID: string
        sourceSessionID: string
        text: string
        files: HandoffFile[]
        attachFiles: boolean
      }
      // Each location runs its own server plugin instance; reply to the one that sent the draft.
      const location = event.location
      if (disposed || !showing(sourceSessionID)) return
      const { claimed } = (await handoff.claim({ draftID }, { location })) as { claimed: boolean }
      if (!claimed) return
      if (disposed) {
        await handoff.cancel({ draftID }, { location })
        return
      }

      dismissReview?.()
      let active = true
      let sent = false
      let picker: symbol | undefined
      let cursor = 0
      const dismiss = () => {
        if (!active) return
        active = false
        if (!sent) void handoff.cancel({ draftID }, { location })
      }
      dismissReview = dismiss
      const [summary, setSummary] = createSignal(text)
      const [files, setFiles] = createSignal(initialFiles)
      const [selected, setSelected] = createSignal(0)
      const [view, setView] = createSignal<"summary" | "files">("summary")
      const key = (id: string, fallback: string) => context.keymap.shortcuts(id)[0] ?? fallback
      const theme = context.theme.surface("dialog")
      const action = (title: string, shortcut: string, onTrigger?: () => void) => (
        <text onMouseUp={onTrigger}>
          <span style={{ fg: theme.text.base }}>{title}</span>
          <span style={{ fg: theme.text.muted }}>{` ${shortcut}`}</span>
        </text>
      )

      const Review = () => {
        const dimensions = useTerminalDimensions()
        const compact = () => dimensions().height < 32
        let editor: TextareaRenderable | undefined
        let list: ScrollBoxRenderable | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let revision = 0
        let closed = false
        const [preview, setPreview] = createSignal<HandoffPreview>()
        const [estimateState, setEstimateState] = createSignal("Estimating...")
        const [hoveredRemove, setHoveredRemove] = createSignal<string>()

        const refresh = () => {
          const current = ++revision
          clearTimeout(timer)
          setPreview(undefined)
          setEstimateState("Estimating...")
          timer = setTimeout(async () => {
            try {
              const result = await handoff.preview({ draftID, text: summary(), files: files() }, { location }) as HandoffPreview
              if (closed || current !== revision) return
              setFiles(result.files.map(({ path, description, mode }) => ({ path, description, mode })))
              setSelected((index) => Math.min(index, Math.max(0, result.files.length - 1)))
              setPreview(result)
              setEstimateState("")
            } catch {
              if (!closed && current === revision) setEstimateState("Token estimate unavailable")
            }
          }, 200)
        }
        onMount(() => {
          if (editor) editor.cursorOffset = cursor
          refresh()
          context.renderer.once("frame", () => {
            if (!closed) list?.scrollChildIntoView(`handoff-file-${selected()}`)
          })
        })
        onCleanup(() => {
          closed = true
          clearTimeout(timer)
        })

        const changeFiles = (next: HandoffFile[]) => {
          setFiles(next)
          setSelected((index) => Math.min(index, Math.max(0, next.length - 1)))
          refresh()
        }
        const toggle = (index: number) => {
          if (!attachFiles) return
          changeFiles(files().map((file, i) => i === index ? { ...file, mode: file.mode === "attach" ? "list" : "attach" } : file))
        }
        const remove = (index: number) => changeFiles(files().filter((_, i) => i !== index))
        const listOnly = () => changeFiles(files().map((file) => ({ ...file, mode: "list" })))
        const move = (delta: number) => {
          const index = Math.max(0, Math.min(files().length - 1, selected() + delta))
          setSelected(index)
          list?.scrollChildIntoView(`handoff-file-${index}`)
        }
        const nextFocus = () => { setView(view() === "summary" ? "files" : "summary") }
        const send = async () => {
          const edited = summary().trim()
          if (!active || !edited || sent) return
          const choices = files()
          sent = true
          context.ui.dialog.clear()
          try {
            const { sessionID } = await handoff.start({ draftID, text: edited, files: choices }, { location }) as { sessionID: string }
            context.ui.router.navigate({ type: "session", sessionID })
            context.ui.toast.show({ message: "Handoff started", variant: "success" })
          } catch (error) {
            context.ui.toast.show({ title: "Handoff failed", message: error instanceof Error ? error.message : String(error), variant: "error" })
          }
        }
        context.keymap.layer(() => ({
          mode: "global",
          priority: 100,
          commands: [
            { bind: "tab", run: () => nextFocus() },
            { bind: "shift+tab", run: () => nextFocus() },
            { bind: "ctrl+f", run: () => { setView("files") } },
            { bind: "ctrl+a", enabled: view() === "files", run: chooseFile },
            { bind: "ctrl+l", enabled: view() === "files", run: listOnly },
            { bind: "ctrl+s", run: send },
            { bind: "escape", enabled: view() === "files", run: () => { setView("summary") } },
            { bind: "up", enabled: view() === "files", run: () => move(-1) },
            { bind: "down", enabled: view() === "files", run: () => move(1) },
            { bind: "return", enabled: view() === "files", run: () => toggle(selected()) },
            { bind: "space", enabled: view() === "files", run: () => toggle(selected()) },
            { bind: "ctrl+d", enabled: view() === "files", run: () => remove(selected()) },
          ],
        }))
        const tokens = (count: number | null) => count === null ? "unavailable" : `~${count.toLocaleString()}`
        const selectedRow = (index: number) => view() === "files" && selected() === index
        const status = (index: number) => {
          const file = files()[index]
          if (!file || file.mode === "list") return "Omit"
          const attachment = preview()?.files[index]?.attachment
          return attachment && "reason" in attachment ? "Blocked" : "Include"
        }
        const fileTokens = (index: number) => {
          if (files()[index]?.mode === "list") return "0"
          const attachment = preview()?.files[index]?.attachment
          return attachment && "tokens" in attachment ? tokens(attachment.tokens) : "?"
        }
        const note = (index: number) => {
          const attachment = preview()?.files[index]?.attachment
          return attachment && "reason" in attachment ? `Not attached: ${attachment.reason}` : undefined
        }
        const tokenWidth = () => Math.max(6, ...files().map((_, index) => fileTokens(index).length))
        const fileRows = () => {
          const width = Math.min(116, dimensions().width - 2) - 4
          return files().reduce((height, file, index) => height
            + Math.max(1, Math.ceil(file.path.length / Math.max(1, width - tokenWidth() - 17)))
            + Math.ceil((note(index)?.length ?? 0) / Math.max(1, width - 4)), 0)
        }
        const listHeight = () => Math.min(Math.max(3, fileRows()), Math.max(3, Math.floor((dimensions().height - (compact() ? 12 : 20)) * 0.4)))
        const editorHeight = () => Math.max(6, dimensions().height - listHeight() - (compact() ? 12 : 20))
        return (
          <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={compact() ? 0 : 1}>
            <box flexDirection="row" justifyContent="space-between">
              <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
                Review handoff
              </text>
              <text fg={theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>
                esc
              </text>
            </box>
            <box gap={compact() ? 0 : 1}>
              <box flexShrink={0} minWidth={0}>
                <Show when={!compact()}><text fg={theme.text.muted} onMouseUp={() => setView("summary")}>Summary</text></Show>
                <box backgroundColor={theme.background.raised.high} paddingLeft={1} paddingRight={1} paddingTop={compact() ? 0 : 1} paddingBottom={compact() ? 0 : 1}>
                  <textarea
                    id="handoff-summary"
                    ref={(value: TextareaRenderable) => (editor = value)}
                    initialValue={summary()}
                    focused={view() === "summary"}
                    wrapMode="word"
                    height={editorHeight()}
                    onMouseUp={() => setView("summary")}
                    onCursorChange={() => { cursor = editor?.cursorOffset ?? cursor }}
                    textColor={theme.text.formfield.base}
                    focusedTextColor={theme.text.formfield.base}
                    backgroundColor={theme.background.raised.high}
                    focusedBackgroundColor={theme.background.raised.high}
                    cursorColor={theme.text.base}
                    onContentChange={() => { setSummary(editor?.plainText ?? summary()); refresh() }}
                    onSubmit={() => void send()}
                  />
                </box>
              </box>
              <box width="100%" flexShrink={0} onMouseUp={() => setView("files")}>
                <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={fileRows() > listHeight() ? 2 : 1}>
                  <text width={3}>{" "}</text>
                  <text fg={theme.text.muted} flexGrow={1}>Files</text>
                  <text fg={theme.text.muted} width={tokenWidth()}>Tokens</text>
                  <text fg={theme.text.muted} width={8}>Contents</text>
                </box>
                <box backgroundColor={theme.background.raised.high} paddingLeft={1} paddingRight={1} paddingTop={compact() ? 0 : 1} paddingBottom={compact() ? 0 : 1}>
                  <scrollbox
                    id="handoff-files"
                    ref={(value: ScrollBoxRenderable) => (list = value)}
                    height={listHeight()}
                    backgroundColor={theme.background.raised.high}
                  >
                    <Show when={files().length} fallback={<text fg={theme.text.muted}>No files selected</text>}>
                      <For each={files()}>{(file, index) => (
                        <box id={`handoff-file-${index()}`} flexShrink={0}
                          backgroundColor={selectedRow(index()) ? theme.background.action.primary.focused : undefined}
                          onMouseUp={() => { setView("files"); setSelected(index()) }}>
                          <box flexDirection="row" gap={1}>
                            <text
                              fg={theme.text.action.destructive.state({ hovered: hoveredRemove() === file.path })}
                              bg={theme.background.action.destructive.state({ hovered: hoveredRemove() === file.path })}
                              width={3} flexShrink={0}
                              onMouseOver={() => setHoveredRemove(file.path)}
                              onMouseOut={() => setHoveredRemove(undefined)}
                              onMouseUp={(event) => { event.stopPropagation(); setHoveredRemove(undefined); setView("files"); setSelected(index()); remove(index()) }}
                            >[x]</text>
                            <text fg={selectedRow(index()) ? theme.text.action.primary.focused : theme.text.base} wrapMode="word" flexGrow={1} flexBasis={0}>{file.path}</text>
                            <text fg={selectedRow(index()) ? theme.text.action.primary.focused : theme.text.muted} width={tokenWidth()} flexShrink={0}>{fileTokens(index())}</text>
                            <text fg={selectedRow(index()) ? theme.text.action.primary.focused : attachFiles ? theme.text.base : theme.text.muted} width={8} flexShrink={0} onMouseUp={(event) => { event.stopPropagation(); setView("files"); setSelected(index()); toggle(index()) }}>{status(index())}</text>
                          </box>
                          <Show when={note(index())}><text fg={selectedRow(index()) ? theme.text.action.primary.focused : theme.text.muted} paddingLeft={4} wrapMode="word">{note(index())}</text></Show>
                        </box>
                      )}</For>
                    </Show>
                  </scrollbox>
                </box>
              </box>
            </box>
            <box gap={compact() ? 0 : 1}>
              <box minWidth={0}>
                <text fg={theme.text.base}>{preview()
                  ? `Prompt ${tokens(preview()!.promptTokens)} + file contents ${tokens(preview()!.attachmentTokens)} = ${tokens(preview()!.totalTokens)} tokens`
                  : estimateState()}</text>
                <text fg={theme.text.muted}>Excludes OpenCode system prompts and tools.</text>
              </box>
              <box width="100%" flexShrink={0}>
                <box flexDirection="row" gap={2}>
                  <text fg={theme.text.muted}>{`${files().length} files`}</text>
                  <Show when={view() === "files"}>
                    <Show when={attachFiles}>{action("toggle", "space", () => toggle(selected()))}</Show>
                  </Show>
                  {action(attachFiles ? "Attach file" : "Add file path", view() === "files" ? "ctrl+a" : "", chooseFile)}
                  <Show when={view() === "files" && files().length}>{action("remove", "ctrl+d", () => remove(selected()))}</Show>
                </box>
                <box flexDirection="row" gap={2}>
                  <Show when={attachFiles} fallback={<text fg={theme.text.muted}>Attachments disabled in config</text>}>
                    {action("Exclude all file contents", view() === "files" ? "ctrl+l" : "", listOnly)}
                  </Show>
                  <Show when={fileRows() > listHeight()}><text fg={theme.text.muted}>Scroll for more</text></Show>
                </box>
              </box>
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <box flexDirection="row" gap={2}>
                <Show when={view() === "summary"} fallback={action("summary", "tab", () => setView("summary"))}>
                  {action("newline", key("input.newline", "shift+enter"))}
                  {action("files", "tab", () => setView("files"))}
                </Show>
                {action("cancel", "esc", () => context.ui.dialog.clear())}
              </box>
              {action("send", view() === "summary" ? key("input.submit", "enter") : "ctrl+s", () => void send())}
            </box>
          </box>
        )
      }

      const chooseFile = async () => {
        if (!active || picker) return
        const currentPicker = Symbol()
        picker = currentPicker
        setView("files")
        const [matches, setMatches] = createSignal<DialogSelectOption<string>[]>([])
        let query: string | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let revision = 0
        let closed = false
        const back = () => {
          if (!active || picker !== currentPicker) return
          picker = undefined
          showReview()
        }
        try {
          const path = await context.ui.dialog.select({
            title: attachFiles ? "Attach a file" : "Add a file path",
            placeholder: "Search project files",
            options: [],
            actions: [{ title: "Back to handoff", bind: "escape", selection: "none", onTrigger: back }],
            search(value) {
              if (value !== query) {
                query = value
                const current = ++revision
                clearTimeout(timer)
                setMatches([])
                timer = setTimeout(async () => {
                  try {
                    const result = await context.client.file.find({ location, query: value, type: "file", limit: 20 })
                    if (closed || current !== revision) return
                    setMatches(result.data
                      .filter((entry) => !files().some((file) => file.path === entry.path))
                      .map((entry) => ({ title: entry.path, value: entry.path })))
                  } catch {
                    if (!closed && current === revision) context.ui.toast.show({ message: "Could not search project files", variant: "error" })
                  }
                }, 100)
              }
              return matches()
            },
          })
          if (active && picker === currentPicker && path !== undefined) {
            setFiles([...files(), { path, description: "", mode: attachFiles ? "attach" : "list" }])
            setSelected(files().length - 1)
            back()
          }
        } finally {
          closed = true
          clearTimeout(timer)
          if (picker === currentPicker) {
            picker = undefined
            dismiss()
          }
        }
      }
      const showReview = () => {
        context.ui.dialog.show(
          () => <Review />,
          () => {
            if (!picker) dismiss()
          }
        )
        context.ui.dialog.set({ size: "xlarge", centered: true })
      }
      showReview()
    })

    return () => {
      disposed = true
      dismissReview?.()
      stopStarted()
      stopDraft()
    }
  },
})
