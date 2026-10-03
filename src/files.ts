/**
 * File reference parsing and resolution for handoff sessions.
 *
 * Handles extraction of @file references from handoff prompts and
 * resolving them to absolute paths of readable text files. Resolved files
 * are attached to the admitted prompt via `event.prompt.files`, so they
 * follow OpenCode's normal attachment resolution path.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { isBinaryFile } from "./vendor"

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
 * Resolve @file references to absolute paths of readable text files.
 *
 * Non-existent paths, directories, and binary files are skipped silently.
 *
 * @param directory - Project directory to resolve relative paths against
 * @param refs - Set of file path references to check
 * @returns Absolute paths of files safe to attach to the handoff prompt
 */
export async function resolveHandoffFiles(
  directory: string,
  refs: Set<string>
): Promise<string[]> {
  const resolved: string[] = []

  for (const ref of refs) {
    const filepath = path.resolve(directory, ref)

    try {
      // Check if file exists
      const stats = await fs.stat(filepath)
      if (!stats.isFile()) continue

      // Skip binary files
      if (await isBinaryFile(filepath)) continue

      resolved.push(filepath)
    } catch {
      // Skip silently if file can't be read
    }
  }

  return resolved
}
