/**
 * V2 tool definitions for opencode-handoff.
 *
 * V1 used `tool()` + zod schemas against `client`. V2 registers plain
 * JSON Schema definitions through `ctx.tool.transform()` and executes
 * against the plugin context (`ctx.session.*`).
 */

/** Minimal surface of the V2 plugin context this file needs. */
export interface HandoffPluginCtx {
  location: { directory: string }
  session: {
    create: (input: Record<string, unknown>) => Promise<{ id?: string } & Record<string, unknown>>;
    prompt: (input: Record<string, unknown>) => Promise<unknown>;
    context: (input: Record<string, unknown>) => Promise<unknown>;
  };
}

export interface V2ToolDef {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (args: Record<string, any>, toolCtx?: { sessionID?: string }) => Promise<{ content: string }>;
}

function sessionRefLine(sessionID: string): string {
  return `Continuing work from session ${sessionID}. When you lack specific information you can use read_session to get it.`;
}

function toFileRefs(files: unknown): string {
  if (!Array.isArray(files) || files.length === 0) return "";
  return (files as unknown[])
    .map((f) => `@${String(f).replace(/^@/, "")}`)
    .join(" ");
}

/**
 * handoff_session: create a new session carrying the handoff prompt.
 * V1 drove the TUI (session_new + appendPrompt + toast); V2 has no TUI
 * domain, so this creates the session server-side. On failure it returns
 * the full prompt text so nothing is lost (paste manually).
 */
export function handoffSessionDef(ctx: HandoffPluginCtx): V2ToolDef {
  return {
    name: "handoff_session",
    description: "Create a new session with the handoff prompt as an editable draft",
    input: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The generated handoff prompt" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Array of file paths to load into the new session's context",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    execute: async (args, toolCtx) => {
      const sessionID = toolCtx?.sessionID ?? "unknown-session";
      const fileRefs = toFileRefs(args["files"]);
      const fullPrompt = fileRefs
        ? `${sessionRefLine(sessionID)}\n\n${fileRefs}\n\n${String(args["prompt"] ?? "")}`
        : `${sessionRefLine(sessionID)}\n\n${String(args["prompt"] ?? "")}`;

      try {
        const created = await ctx.session.create({ title: "Handoff" });
        const newID = (created as { id?: string })?.id;
        if (newID) {
          await ctx.session.prompt({ sessionID: newID, text: fullPrompt });
          return { content: `Handoff prompt created in session ${newID}. Review and edit before sending.` };
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error";
        return {
          content:
            `Could not auto-create the new session (${reason}). ` +
            `Create one manually and paste this prompt:\n\n${fullPrompt}`,
        };
      }
      return { content: fullPrompt };
    },
  };
}

/** Format a conversation transcript for display (V1 logic, shape-defensive). */
export function formatTranscript(
  messages: Array<{ info?: any; role?: string; parts?: any[] }>,
  limit?: number
): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const role = msg.info?.role ?? (msg as { role?: string }).role;
    const parts: any[] = Array.isArray(msg.parts) ? msg.parts : [];

    if (role === "user") {
      lines.push("## User");
      for (const part of parts) {
        if (part?.type === "text" && !part.ignored) lines.push(String(part.text ?? ""));
        if (part?.type === "file") lines.push(`[Attached: ${part.filename || "file"}]`);
      }
      lines.push("");
    }

    if (role === "assistant") {
      lines.push("## Assistant");
      for (const part of parts) {
        if (part?.type === "text") lines.push(String(part.text ?? ""));
        if (part?.type === "tool" && part.state?.status === "completed") {
          lines.push(`[Tool: ${part.tool}] ${part.state.title}`);
        }
      }
      lines.push("");
    }
  }

  const output = lines.join("\n").trim();

  if (messages.length >= (limit ?? 100)) {
    return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`;
  }

  return output + `\n\n(End of session - ${messages.length} messages)`;
}

function asMessages(value: unknown): Array<{ info?: any; role?: string; parts?: any[] }> {
  if (Array.isArray(value)) return value;
  const data = (value as { data?: unknown })?.data;
  if (Array.isArray(data)) return data as Array<{ info?: any; role?: string; parts?: any[] }>;
  return [];
}

/**
 * read_session: fetch a previous session transcript.
 * V1 used `client.session.messages`; V2 uses `ctx.session.context`.
 */
export function readSessionDef(ctx: HandoffPluginCtx): V2ToolDef {
  return {
    name: "read_session",
    description:
      "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the handoff summary.",
    input: {
      type: "object",
      properties: {
        sessionID: { type: "string", description: "The full session ID (e.g., sess_01jxyz...)" },
        limit: { type: "number", description: "Maximum number of messages to read (defaults to 100, max 500)" },
      },
      required: ["sessionID"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const sessionID = String(args["sessionID"] ?? "");
      const rawLimit = typeof args["limit"] === "number" ? args["limit"] : 100;
      const limit = Math.min(rawLimit, 500);

      try {
        const response = await ctx.session.context({ sessionID });
        const messages = asMessages(response).slice(-limit);

        if (messages.length === 0) {
          return { content: "Session has no messages or does not exist." };
        }

        return { content: formatTranscript(messages, limit) };
      } catch (error) {
        return {
          content: `Could not read session ${sessionID}: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }
    },
  };
}
