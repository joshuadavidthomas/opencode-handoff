/**
 * File reference parsing and building for handoff sessions.
 *
 * Handles extraction of @file references from handoff prompts and
 * building file parts for injection into new sessions.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import type { FilePartInput } from "@opencode-ai/sdk"

/**
 * File reference regex matching OpenCode's internal pattern.
 * Matches @file references like @src/plugin.ts
 */
export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

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
 * Build file parts for files that exist.
 *
 * @param directory - Project directory to resolve relative paths against
 * @param refs - Set of file path references to check
 * @returns Array of file parts for existing files (non-existent files are skipped)
 */
export async function buildFileParts(
  directory: string,
  refs: Set<string>
): Promise<FilePartInput[]> {
  const fileParts: FilePartInput[] = []

  for (const ref of refs) {
    const filepath = path.resolve(directory, ref)

    try {
      await fs.stat(filepath)
      fileParts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${filepath}`,
        filename: ref,
      })
    } catch {
      // Skip silently if file doesn't exist
    }
  }

  return fileParts
}
