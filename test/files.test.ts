import { describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs/promises"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { estimateTokens, prepareFiles } from "../src/files"

describe("estimateTokens", () => {
  test("rounds partial groups up and handles empty text", () => {
    expect(["", "abcd", "abcde"].map(estimateTokens)).toEqual([0, 1, 2])
  })
})

describe("prepareFiles", () => {
  test("rejects known binary extensions without needing access to their contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-binary-"))
    await writeFile(join(directory, "archive.ZIP"), "archive contents")
    const read = spyOn(fs, "readFile").mockRejectedValue(new Error("Contents unavailable"))
    try {
      expect(await prepareFiles(directory, [{ path: "archive.ZIP", description: "archive", mode: "attach" }], true)).toEqual({
        files: [{ path: "archive.ZIP", description: "archive", mode: "attach", attachment: { reason: "Binary file" } }],
        attachments: [],
      })
    } finally {
      read.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("deduplicates choices, estimates attachments, and retains unavailable files as references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-files-"))

    try {
      await writeFile(join(directory, "note with spaces.txt"), "alpha\nbeta")
      await writeFile(join(directory, "archive.bin"), new Uint8Array([0, 1, 2]))
      await writeFile(join(directory, "no-extension"), new Uint8Array([65, 0, 66]))
      await mkdir(join(directory, "nested"))

      const result = await prepareFiles(directory, [
        { path: "./note with spaces.txt", description: "notes", mode: "list" },
        { path: "note with spaces.txt", description: "duplicate", mode: "attach" },
        { path: "archive.bin", description: "archive", mode: "attach" },
        { path: "no-extension", description: "binary content", mode: "attach" },
        { path: "nested", description: "directory", mode: "attach" },
        { path: "missing.txt", description: "missing", mode: "attach" },
        { path: "reference.txt", description: "read later", mode: "list" },
      ], true)

      expect(result.attachments).toEqual([
        { uri: pathToFileURL(join(directory, "note with spaces.txt")).href, name: "note with spaces.txt" },
      ])
      expect(result.files).toEqual([
        { path: "note with spaces.txt", description: "notes", mode: "attach", attachment: { tokens: 3 } },
        { path: "archive.bin", description: "archive", mode: "attach", attachment: { reason: "Binary file" } },
        { path: "no-extension", description: "binary content", mode: "attach", attachment: { reason: "Binary file" } },
        { path: "nested", description: "directory", mode: "attach", attachment: { reason: "Not a regular file" } },
        { path: "missing.txt", description: "missing", mode: "attach", attachment: { reason: "Missing or unreadable file" } },
        { path: "reference.txt", description: "read later", mode: "list", attachment: null },
      ])
      expect(await prepareFiles(directory, [{ path: "note with spaces.txt", description: "notes", mode: "attach" }], false)).toEqual({
        files: [{ path: "note with spaces.txt", description: "notes", mode: "list", attachment: null }],
        attachments: [],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
