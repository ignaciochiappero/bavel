/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Backpressure for the tab-listening chunk queue.
//
// The VAD emits a chunk roughly every second. If the pipeline needs longer
// than that to process one, the queue grows and the delay behind the speaker
// increases without bound — a 30-minute meeting ends up minutes late.
//
// The fix is NOT to drop audio (that loses words). Queued chunks are
// consecutive slices of the same utterance, so they are merged into a single
// append: all the audio is preserved and the recognizer runs once instead of
// N times. Dropping only happens past a hard ceiling, where the alternative
// would be one enormous request that stalls the pipeline even further.

const BYTES_PER_SAMPLE = 4 // Float32

export function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function bytesToBase64(bytes) {
  // Chunked so a long buffer cannot blow the argument limit of fromCharCode.
  const CHUNK = 8192
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// Merges queued chunks into one. `maxSamples` caps the merged audio; when it
// is exceeded the OLDEST samples are dropped, since the newest audio is the
// one the listener is still waiting to see translated.
//
// Returns null for an empty input, otherwise:
//   { base64Data, final, mergedCount, droppedSamples }
export function coalescePcmChunks(chunks, { maxSamples = Infinity } = {}) {
  if (!chunks || chunks.length === 0) return null

  const buffers = chunks.map((c) => base64ToBytes(c.base64Data))
  const totalBytes = buffers.reduce((sum, b) => sum + b.length, 0)

  let merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const buf of buffers) {
    merged.set(buf, offset)
    offset += buf.length
  }

  let droppedSamples = 0
  const maxBytes =
    maxSamples === Infinity ? Infinity : maxSamples * BYTES_PER_SAMPLE
  if (merged.length > maxBytes) {
    // Keep the tail, aligned to a whole sample so frames stay intact.
    const keep = Math.floor(maxBytes / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE
    droppedSamples = (merged.length - keep) / BYTES_PER_SAMPLE
    merged = merged.subarray(merged.length - keep)
  }

  return {
    base64Data: bytesToBase64(merged),
    // The merged chunk ends an utterance if its LAST piece did.
    final: Boolean(chunks[chunks.length - 1].final),
    mergedCount: chunks.length,
    droppedSamples,
  }
}

// Drains every queued chunk as a single coalesced unit. Mutates `queue`.
export function drainQueue(queue, options) {
  if (queue.length === 0) return null
  const pending = queue.splice(0, queue.length)
  return coalescePcmChunks(pending, options)
}
