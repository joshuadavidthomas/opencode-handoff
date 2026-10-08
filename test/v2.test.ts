import { describe, test, expect } from "bun:test";
import plugin from "../src/plugin";
import { parseFileReferences } from "../src/files";

describe("V2 loader contract (issue #33)", () => {
  test("default-exports a definition with id and setup", () => {
    const def = plugin as unknown as Record<string, unknown>;
    expect(def["id"]).toBe("handoff");
    expect(typeof def["setup"]).toBe("function");
  });

  test("setup registers handoff command and both tools", async () => {
    const commands: string[] = [];
    const tools: string[] = [];
    const fakeCtx = {
      location: { directory: "C:\\tmp", project: { id: "p1" } },
      options: {},
      command: {
        transform: async (cb: (e: { add: (d: { name: string }) => void }) => void) => {
          cb({ add: (d) => { commands.push(d.name); } });
          return { dispose: async () => {} };
        },
      },
      tool: {
        transform: async (cb: (e: { add: (d: { name: string }) => void }) => void) => {
          cb({ add: (d) => { tools.push(d.name); } });
          return { dispose: async () => {} };
        },
      },
      event: { subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
      session: {},
    };
    await (plugin as unknown as { setup: (c: unknown) => Promise<unknown> }).setup(fakeCtx);
    expect(commands).toContain("handoff");
    expect(tools).toContain("handoff_session");
    expect(tools).toContain("read_session");
  });
});

describe("handoff behavior preserved", () => {
  test("parseFileReferences extracts @file refs", () => {
    const refs = parseFileReferences("see @src/foo.ts and @src/bar.ts please");
    expect(refs.has("src/foo.ts")).toBe(true);
    expect(refs.has("src/bar.ts")).toBe(true);
  });
});
