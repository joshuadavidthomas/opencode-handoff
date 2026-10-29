import * as path from "node:path"
import * as fs from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { hasBinaryExtension, isBinaryFile } from "./vendor"
import type { FilePreview, HandoffFile } from "./rpc"

export interface FileAttachment {
  readonly uri: string
  readonly name: string
}

/** Rough, model-independent estimate. Excludes host message and attachment wrappers. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Resolve choices once for both preview and delivery. List-only entries never read file contents. */
export async function prepareFiles(
  directory: string,
  files: readonly HandoffFile[],
  attachFiles: boolean
): Promise<{ files: FilePreview[]; attachments: FileAttachment[] }> {
  const choices = new Map<string, HandoffFile>()
  for (const file of files) {
    const filepath = path.resolve(directory, file.path.trim())
    const previous = choices.get(filepath)
    choices.set(filepath, {
      path: path.relative(directory, filepath),
      description: (previous?.description || file.description).replace(/\s+/g, " ").trim(),
      mode: attachFiles && (file.mode === "attach" || previous?.mode === "attach") ? "attach" : "list",
    })
  }

  const previews: FilePreview[] = []
  const attachments: FileAttachment[] = []
  for (const [filepath, file] of choices) {
    if (file.mode === "list") {
      previews.push({ ...file, attachment: null })
      continue
    }
    try {
      const stats = await fs.stat(filepath)
      if (!stats.isFile()) {
        previews.push({ ...file, attachment: { reason: "Not a regular file" } })
        continue
      }
      if (hasBinaryExtension(filepath)) {
        previews.push({ ...file, attachment: { reason: "Binary file" } })
        continue
      }
      const buffer = await fs.readFile(filepath)
      if (isBinaryFile(filepath, buffer)) {
        previews.push({ ...file, attachment: { reason: "Binary file" } })
        continue
      }
      previews.push({ ...file, attachment: { tokens: estimateTokens(buffer.toString("utf8")) } })
      attachments.push({ uri: pathToFileURL(filepath).href, name: file.path })
    } catch {
      previews.push({ ...file, attachment: { reason: "Missing or unreadable file" } })
    }
  }
  return { files: previews, attachments }
}
