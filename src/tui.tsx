/** @jsxImportSource @opentui/solid */
import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import { Handoff } from "./rpc"

/**
 * Shows a handoff draft for editing before it is sent. Only a TUI that has
 * the source session open claims the draft.
 */
export default Plugin.define({
  id: "opencode-handoff-tui",
  setup(context) {
    const handoff = context.client.rpc(Handoff)

    return handoff.events.on("draft", async (event) => {
      const { draftID, sourceSessionID, text } = event.data as {
        draftID: string
        sourceSessionID: string
        text: string
      }
      // Each location runs its own server plugin instance; reply to the one that sent the draft.
      const location = event.location
      const route = context.ui.router.current()
      const showing = route.type === "session" && route.sessionID === sourceSessionID
      if (!showing && !context.ui.tabs.list().some((tab) => tab.sessionID === sourceSessionID)) return
      const { claimed } = (await handoff.claim({ draftID }, { location })) as { claimed: boolean }
      if (!claimed) return

      let editor: TextareaRenderable | undefined
      let sent = false

      const send = async () => {
        const edited = editor?.plainText.trim()
        if (!edited) return
        sent = true
        context.ui.dialog.clear()
        try {
          const { sessionID } = (await handoff.start({ draftID, text: edited }, { location })) as { sessionID: string }
          context.ui.router.navigate({ type: "session", sessionID })
          context.ui.toast.show({ message: "Handoff started", variant: "success" })
        } catch (error) {
          context.ui.toast.show({
            title: "Handoff failed",
            message: error instanceof Error ? error.message : String(error),
            variant: "error",
          })
        }
      }

      // The host drives text inputs through its keymap, so show the user's own keys.
      const key = (id: string, fallback: string) => context.keymap.shortcuts(id)[0] ?? fallback
      const theme = context.theme.surface("dialog")

      const action = (title: string, shortcut: string, onTrigger?: () => void) => (
        <text onMouseUp={onTrigger}>
          <span style={{ fg: theme.text.base }}>{title}</span>
          <span style={{ fg: theme.text.muted }}>{` ${shortcut}`}</span>
        </text>
      )

      context.ui.dialog.show(
        () => (
          <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
            <box flexDirection="row" justifyContent="space-between">
              <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
                Review handoff
              </text>
              <text fg={theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>
                esc
              </text>
            </box>
            <box backgroundColor={theme.background.raised.high} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
              <textarea
                ref={(value: TextareaRenderable) => (editor = value)}
                initialValue={text}
                focused
                wrapMode="word"
                minHeight={6}
                maxHeight={Math.max(6, context.renderer.height - 18)}
                textColor={theme.text.formfield.base}
                focusedTextColor={theme.text.formfield.base}
                backgroundColor={theme.background.raised.high}
                focusedBackgroundColor={theme.background.raised.high}
                cursorColor={theme.text.base}
                onSubmit={() => void send()}
              />
            </box>
            <box flexDirection="row" justifyContent="space-between">
              <box flexDirection="row" gap={2}>
                {action("newline", key("input.newline", "shift+enter"))}
                {action("cancel", "esc", () => context.ui.dialog.clear())}
              </box>
              {action("send", key("input.submit", "enter"), () => void send())}
            </box>
          </box>
        ),
        () => {
          if (!sent) void handoff.cancel({ draftID }, { location })
        }
      )
      context.ui.dialog.set({ size: "xlarge", centered: true })
    })
  },
})
