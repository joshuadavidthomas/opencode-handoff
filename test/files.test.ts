import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSyntheticFileParts, parseFileReferences } from "../src/files"

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

describe("buildSyntheticFileParts", () => {
  test("builds Read-compatible parts and skips unsuitable references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-handoff-files-"))

    try {
      const textPath = join(directory, "note.txt")
      await writeFile(textPath, "alpha\nbeta")
      await writeFile(join(directory, "archive.bin"), new Uint8Array([0, 1, 2]))
      await mkdir(join(directory, "nested"))

      const parts = await buildSyntheticFileParts(
        directory,
        new Set(["note.txt", "archive.bin", "nested", "missing.txt"])
      )

      expect(parts).toEqual([
        {
          type: "text",
          synthetic: true,
          text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: textPath })}`,
        },
        {
          type: "text",
          synthetic: true,
          text: [
            "<file>",
            "00001| alpha",
            "00002| beta",
            "",
            "(End of file - total 2 lines)",
            "</file>",
          ].join("\n"),
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
