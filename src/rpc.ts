import { Rpc } from "@opencode/plugin/rpc"

export const HandoffFileSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    description: { type: "string" },
    mode: { type: "string", enum: ["attach", "list"] },
  },
  required: ["path", "description", "mode"],
  additionalProperties: false,
} as const

export interface HandoffFile {
  readonly path: string
  readonly description: string
  readonly mode: (typeof HandoffFileSchema.properties.mode.enum)[number]
}

export interface FilePreview extends HandoffFile {
  readonly attachment: { tokens: number } | { reason: string } | null
}

export interface HandoffPreview {
  readonly files: FilePreview[]
  readonly promptTokens: number
  readonly attachmentTokens: number | null
  readonly totalTokens: number | null
}

const DraftEdit = {
  type: "object",
  properties: {
    draftID: { type: "string" },
    text: { type: "string" },
    files: { type: "array", items: HandoffFileSchema },
  },
  required: ["draftID", "text", "files"],
  additionalProperties: false,
} as const

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
 * TUI claims the draft, the server starts the handoff session itself; with
 * review turned off, it starts it right away. Either way it announces
 * `started` so the TUI can switch to it.
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
      input: DraftEdit,
      output: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      errors: { not_found: DraftID },
    },
    preview: {
      input: DraftEdit,
      output: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: {
              ...HandoffFileSchema,
              properties: {
                ...HandoffFileSchema.properties,
                attachment: {
                  anyOf: [
                    { type: "null" },
                    { type: "object", properties: { tokens: { type: "number" } }, required: ["tokens"], additionalProperties: false },
                    { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
                  ],
                },
              },
              required: [...HandoffFileSchema.required, "attachment"],
            },
          },
          promptTokens: { type: "number" },
          attachmentTokens: { type: ["number", "null"] },
          totalTokens: { type: ["number", "null"] },
        },
        required: ["files", "promptTokens", "attachmentTokens", "totalTokens"],
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
          files: { type: "array", items: HandoffFileSchema },
          attachFiles: { type: "boolean" },
        },
        required: ["draftID", "sourceSessionID", "text", "files", "attachFiles"],
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
