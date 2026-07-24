import { describe, expect, test } from "bun:test"
import { formatFileContent } from "../src/vendor"

describe("formatFileContent", () => {
  test("limits line length and the number of lines", () => {
    const content = [
      "x".repeat(2001),
      ...Array.from({ length: 2000 }, () => "line"),
    ].join("\n")

    const output = formatFileContent("ignored", content)

    expect(output).toContain(`00001| ${"x".repeat(2000)}...`)
    expect(output).toContain("02000| line")
    expect(output).not.toContain("02001| line")
    expect(output).toContain(
      "(File has more lines. Use 'offset' parameter to read beyond line 2000)"
    )
  })
})
