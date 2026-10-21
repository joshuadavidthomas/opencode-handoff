/**
 * File reference handling for handoff sessions.
 *
 * Turns the files a handoff names into prompt attachments, which OpenCode
 * reads and loads into the new session's context.
 */

import * as path from "node:path"
import * as fs from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { isBinaryFile } from "./vendor"

/**
 * File reference regex matching OpenCode's internal pattern.
 * Matches @file references like @src/plugin.ts
 */
export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g

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
 * @param refs - File path references, with or without a leading @
 * @returns Attachments for readable text files (missing, duplicate, and binary files are skipped)
 */
export async function buildFileAttachments(
  directory: string,
  refs: Iterable<string>
): Promise<FileAttachment[]> {
  const attachments = new Map<string, FileAttachment>()

  for (const ref of refs) {
    const filepath = path.resolve(directory, ref.replace(/^@/, ""))

    try {
      const stats = await fs.stat(filepath)
      if (!stats.isFile()) continue

      if (await isBinaryFile(filepath)) continue

      const uri = pathToFileURL(filepath).href
      attachments.set(uri, { uri, name: path.relative(directory, filepath) })
    } catch {
      // Skip silently if the reference doesn't resolve to a readable file
    }
  }

  return [...attachments.values()]
}
