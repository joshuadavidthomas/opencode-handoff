/**
 * opencode-handoff — OpenCode V2 port (local).
 *
 * V1 exported `export const HandoffPlugin: Plugin` (factory returning
 * `{ config, tool, "chat.message", event }`), which V2 rejects with
 * "Plugin must export a default definition with an id and an effect or
 * setup function" (upstream issue #33).
 *
 * V2 shape: plain default-exported `{ id, setup }` (runtime-equivalent
 * to `Plugin.define`, no `@opencode/plugin` runtime import needed so
 * loose installs without node_modules keep working).
 *
 * Mapping:
 * - `config.command["handoff"]` (template) -> `ctx.command.transform`
 *   with `execute` submitting the template + user goal via session.prompt
 * - `tool` map (zod) -> `ctx.tool.transform` with JSON Schema defs
 * - `"chat.message"` file auto-injection -> dropped in this port:
 *   the handoff prompt already carries `@file` refs, which the new
 *   session resolves through the normal attachment pipeline
 * - `event(session.deleted)` -> `ctx.event.subscribe` + cleanup fn
 */

import { handoffSessionDef, readSessionDef } from "./tools";

const HANDOFF_COMMAND = `GOAL: You are creating a handoff message to continue work in a new session.

<context>

When an AI assistant starts a fresh session, it spends significant time exploring the codebase—grepping, reading files, searching—before it can begin actual work. This "file archaeology" is wasteful when the previous session already discovered what matters.

A good handoff frontloads everything the next session needs so it can start implementing immediately.

</context>

<instructions>

Analyze this conversation and extract what matters for continuing the work.

1. Identify all relevant files that should be loaded into the next session's context

   Include files that will be edited, dependencies being touched, relevant tests, configs, and key reference docs. Be generous—the cost of an extra file is low; missing a critical one means another archaeology dig. Target 8-15 files, up to 20 for complex work.

2. Draft the context and goal description

   Describe what we're working on and provide whatever context helps continue the work. Structure it based on what fits the conversation—could be tasks, findings, a simple paragraph, or detailed steps.

   Preserve: decisions, constraints, user preferences, technical patterns.

   Exclude: conversation back-and-forth, dead ends, meta-commentary.

The user controls what context matters. If they mentioned something to preserve, include it—trust their judgment about their workflow.

</instructions>

<user_input>

This is what the next session should focus on. Use it to shape your handoff's direction—don't investigate or search, just incorporate the intent into your context and goals.

If empty, capture a natural continuation of the current conversation's direction.

USER: $ARGUMENTS

</user_input>

---

After generating the handoff message, IMMEDIATELY call handoff_session with your prompt and files:

\`handoff_session(prompt="...", files=["src/foo.ts", "src/bar.ts", ...])\``;

/** Minimal V2 context surface used by setup (kept structural, no SDK import). */
export interface SetupCtx {
  location: { directory: string };
  options?: unknown;
  command: { transform: (cb: (editor: any) => void) => Promise<unknown> };
  tool: { transform: (cb: (editor: any) => void) => Promise<unknown> };
  event: { subscribe: (opts?: { signal?: AbortSignal }) => AsyncIterable<any> };
  session: {
    create: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    prompt: (input: Record<string, unknown>) => Promise<unknown>;
    context: (input: Record<string, unknown>) => Promise<unknown>;
  };
}

export async function setup(ctx: SetupCtx): Promise<() => void> {
  const processedSessions = new Set<string>();

  // /handoff command (V1 config.command template -> V2 command transform)
  await ctx.command.transform((editor) => {
    editor.add({
      name: "handoff",
      description: "Create a focused handoff prompt for a new session",
      execute: async ({ sessionID, prompt, delivery }: { sessionID: string; prompt: { text?: string }; delivery?: string }) => {
        const goal = prompt?.text ?? "";
        const text = HANDOFF_COMMAND.replace("$ARGUMENTS", goal);
        await ctx.session.prompt({ sessionID, text, delivery });
      },
    });
  });

  // Tools (V1 tool map -> V2 tool transform, JSON Schema)
  await ctx.tool.transform((editor) => {
    editor.add(handoffSessionDef(ctx as never));
    editor.add(readSessionDef(ctx as never));
  });

  // Session-deleted bookkeeping (V1 event hook -> V2 subscription)
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event?.type === "session.deleted") {
          const id = event?.properties?.info?.id ?? event?.properties?.id;
          if (typeof id === "string") processedSessions.delete(id);
        }
      }
    } catch {
      // Aborted on unload; ignore.
    }
  })();

  void processedSessions;
  return () => controller.abort();
}

export default { id: "handoff", setup };
