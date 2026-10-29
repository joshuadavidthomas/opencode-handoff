/**
 * Code extracted from OpenCode for compatibility.
 *
 * Source: https://github.com/sst/opencode
 * File: packages/opencode/src/tool/read.ts
 *
 * Copied so handoffs skip the same binary files OpenCode's Read tool refuses.
 */

import * as path from "node:path"

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
export function hasBinaryExtension(filepath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filepath).toLowerCase())
}

export function isBinaryFile(filepath: string, buffer: Uint8Array): boolean {
  if (hasBinaryExtension(filepath)) return true
  if (buffer.length === 0) return false
  const bytes = buffer.subarray(0, 4096)
  let nonPrintableCount = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) {
      nonPrintableCount++
    }
  }
  return nonPrintableCount / bytes.length > 0.3
}
