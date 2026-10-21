/**
 * File reference parsing and attachment building for handoff sessions.
 *
 * Handles extraction of @file references from handoff prompts and building
 * prompt file attachments that OpenCode resolves through its normal
 * attachment loading path.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { pathToFileURL } from "node:url"

/**
 * File reference regex matching OpenCode's internal pattern.
 * Matches @file references like @src/plugin.ts
 */
export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

/**
 * Binary extensions whose contents cannot be attached as text. Matches the
 * set OpenCode's Read tool refuses, keeping V1's behavior of skipping
 * unattachable references rather than failing prompt admission.
 */
const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war",
  ".7z", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods",
  ".odp", ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo"
])

export interface FileAttachment {
  readonly uri: string
  readonly name: string
}

/**
 * Parse @file references from text.
 *
 * @param text - Text to search for @file references
 * @returns Set of file paths referenced in the text
 */
export function parseFileReferences(text: string): Set<string> {
  const fileRefs = new Set<string>()

  for (const match of text.matchAll(FILE_REGEX)) {
    if (match[1]) {
      fileRefs.add(match[1])
    }
  }

  return fileRefs
}

/**
 * Build prompt file attachments for referenced files.
 *
 * @param directory - Project directory to resolve relative paths against
 * @param refs - Set of file path references to check
 * @returns Attachment descriptors (non-existent, duplicate, and binary files are skipped)
 */
export async function buildFileAttachments(
  directory: string,
  refs: Set<string>
): Promise<FileAttachment[]> {
  const attachments: FileAttachment[] = []
  const seen = new Set<string>()

  for (const ref of refs) {
    const filepath = path.resolve(directory, ref)

    try {
      const stats = await fs.stat(filepath)
      if (!stats.isFile()) continue

      if (await isBinaryFile(filepath)) continue

      const uri = pathToFileURL(filepath).href
      if (seen.has(uri)) continue
      seen.add(uri)

      attachments.push({ uri, name: path.basename(filepath) })
    } catch {
      // Skip silently if the reference doesn't resolve to a readable file
    }
  }

  return attachments
}

/**
 * Check whether a file is binary based on its extension or leading bytes.
 */
async function isBinaryFile(filepath: string): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()

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
