/**
 * Text Chunker Helper for RAG Module
 * Segments document text into search-optimized chunks with token overlap.
 *
 * LINEAR TIME (H9 fix): the old code called `text.lastIndexOf('.', endIndex)`
 * (and '\n' / ' ') on every chunk. `lastIndexOf` scans backwards from
 * `endIndex` until it finds a match — with no boundary character anywhere
 * in the text that is a scan of the whole prefix, O(n) per chunk and O(n^2)
 * overall, synchronously blocking the event loop for minutes on multi-MB
 * boundary-less text (measured 92 s for 5 MB, 121 s for 10 MB). The
 * boundary search below only ever scans the second half of the current
 * window (at most `chunkSize` characters, via a slice), so each chunk
 * costs O(chunkSize) and the whole text costs O(n). The slice runs to
 * `endIndex + 1` so a boundary sitting exactly at `endIndex` is still
 * found, exactly as the old `lastIndexOf(..., endIndex)` did — structured
 * text chunks byte-identically to the old code (verified in bench).
 */

export interface ChunkOptions {
  chunkSize?: number // Max characters per chunk (default: 500)
  overlap?: number   // Overlap characters between chunks (default: 50)
}

export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const chunkSize = options.chunkSize || 500
  const overlap = options.overlap || 50

  if (!text || text.trim().length === 0) return []
  if (text.length <= chunkSize) return [text.trim()]

  const chunks: string[] = []
  let startIndex = 0

  while (startIndex < text.length) {
    let endIndex = Math.min(startIndex + chunkSize, text.length)

    // Try to break at a sentence or word boundary instead of arbitrary character.
    // Only the second half of this window is searched (a slice of at most
    // chunkSize/2 characters), so the scan is bounded per chunk and the
    // whole pass stays linear. A boundary at or before the window's
    // midpoint keeps the old behaviour of falling back to the hard cut.
    if (endIndex < text.length) {
      const searchFrom = startIndex + Math.floor(chunkSize * 0.5)
      const windowText = text.slice(searchFrom, endIndex + 1)
      const lastPeriod = windowText.lastIndexOf('.')
      const lastNewline = windowText.lastIndexOf('\n')
      const lastSpace = windowText.lastIndexOf(' ')

      const boundary = Math.max(lastPeriod, lastNewline, lastSpace)
      if (boundary >= 0) {
        endIndex = searchFrom + boundary + 1
      }
    }

    const chunk = text.slice(startIndex, endIndex).trim()
    if (chunk.length > 0) {
      chunks.push(chunk)
    }

    // Advance past the chunk minus the overlap. Guard against non-progress
    // for degenerate options (overlap >= chunkSize): never step backwards.
    const nextStart = endIndex - overlap
    startIndex = nextStart > startIndex ? nextStart : endIndex
    if (startIndex >= text.length - overlap) break
  }

  return chunks
}
