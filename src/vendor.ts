/**
 * Code extracted from OpenCode for compatibility.
 *
 * Source: https://github.com/sst/opencode
 * File: packages/opencode/src/tool/read.ts
 *
 * Copied so handoffs skip the same binary files OpenCode's Read tool refuses.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"

/**
 * Binary file extensions (from OpenCode's ReadTool)
 */
const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war",
  ".7z", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods",
  ".odp", ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo"
])

/**
 * Check if a file is binary (copied from OpenCode's ReadTool)
 */
export async function isBinaryFile(filepath: string): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()

  // Check extension first
  if (BINARY_EXTENSIONS.has(ext)) {
    return true
  }

  try {
    const buffer = await fs.readFile(filepath)
    if (!buffer) return false

    const fileSize = buffer.length
    if (fileSize === 0) return false

    const bufferSize = Math.min(4096, fileSize)
    const bytes = buffer.subarray(0, bufferSize)

    let nonPrintableCount = 0
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]
      if (byte === undefined) continue
      if (byte === 0) return true
      if (byte < 9 || (byte > 13 && byte < 32)) {
        nonPrintableCount++
      }
    }

    // If >30% non-printable characters, consider it binary
    return nonPrintableCount / bytes.length > 0.3
  } catch {
    return false
  }
}
