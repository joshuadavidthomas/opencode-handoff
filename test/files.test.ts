import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { buildFileAttachments, parseFileReferences } from "../src/files"

describe("parseFileReferences", () => {
  test("extracts unique file references and ignores email and backtick-prefixed references", () => {
    const refs = parseFileReferences(
      "Load @src/plugin.ts and @./README.md, then @src/plugin.ts again. " +
        "Ignore name@example.com and `@ignored.ts`, but keep @extensionless."
    )

    expect([...refs]).toEqual([
      "src/plugin.ts",
      "./README.md",
      "extensionless",
    ])
  })
})

describe("buildFileAttachments", () => {
  test("attaches readable text files once and skips unsuitable references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-files-"))

    try {
      await writeFile(join(directory, "note.txt"), "alpha\nbeta")
      await writeFile(join(directory, "archive.bin"), new Uint8Array([0, 1, 2]))
      await mkdir(join(directory, "nested"))

      const attachments = await buildFileAttachments(directory, [
        "note.txt",
        "@note.txt",
        "./note.txt",
        "archive.bin",
        "nested",
        "missing.txt",
      ])

      expect(attachments).toEqual([
        { uri: pathToFileURL(join(directory, "note.txt")).href, name: "note.txt" },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
