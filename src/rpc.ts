import { Rpc } from "@opencode/plugin/rpc"

const DraftID = {
  type: "object",
  properties: { draftID: { type: "string" } },
  required: ["draftID"],
  additionalProperties: false,
} as const

/**
 * Contract between the server plugin and the TUI plugin.
 *
 * handoff_session announces a `draft`. A TUI showing the source session
 * `claim`s it, lets the user edit it, then calls `start` or `cancel`. When no
 * TUI claims the draft, the server starts the handoff session itself. With
 * review turned off, the server starts it right away and announces `started`
 * so the TUI can switch to it.
 */
export const Handoff = Rpc.define({
  id: "opencode-handoff",
  methods: {
    claim: {
      input: DraftID,
      output: {
        type: "object",
        properties: { claimed: { type: "boolean" } },
        required: ["claimed"],
        additionalProperties: false,
      },
    },
    start: {
      input: {
        type: "object",
        properties: { draftID: { type: "string" }, text: { type: "string" } },
        required: ["draftID", "text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      errors: { not_found: DraftID },
    },
    cancel: { input: DraftID, output: { type: "object", additionalProperties: false } },
  },
  events: {
    draft: {
      schema: {
        type: "object",
        properties: {
          draftID: { type: "string" },
          sourceSessionID: { type: "string" },
          text: { type: "string" },
        },
        required: ["draftID", "sourceSessionID", "text"],
        additionalProperties: false,
      },
    },
    started: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, sourceSessionID: { type: "string" } },
        required: ["sessionID", "sourceSessionID"],
        additionalProperties: false,
      },
    },
  },
})
