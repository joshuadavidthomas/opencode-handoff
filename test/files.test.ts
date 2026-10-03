import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveHandoffFiles, parseFileReferences } from "../src/files"

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

describe("resolveHandoffFiles", () => {
  test("resolves readable text files and skips unsuitable references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-files-"))

    try {
      const textPath = join(directory, "note.txt")
      await writeFile(textPath, "alpha\nbeta")
      await writeFile(join(directory, "archive.bin"), new Uint8Array([0, 1, 2]))
      await mkdir(join(directory, "nested"))

      const files = await resolveHandoffFiles(
        directory,
        new Set(["note.txt", "archive.bin", "nested", "missing.txt"])
      )

      expect(files).toEqual([textPath])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
