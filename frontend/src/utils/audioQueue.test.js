import { describe, it, expect } from "vitest"
import {
  base64ToBytes,
  bytesToBase64,
  coalescePcmChunks,
  drainQueue,
} from "./audioQueue"

// Builds a base64 chunk out of Float32 samples, mirroring what the capture
// hook sends (raw Float32Array buffer, base64-encoded).
function chunkOf(samples, final = false) {
  const f32 = new Float32Array(samples)
  return { base64Data: bytesToBase64(new Uint8Array(f32.buffer)), final }
}

function samplesOf(base64) {
  return Array.from(new Float32Array(base64ToBytes(base64).buffer))
}

describe("base64 round-trip", () => {
  it("preserves bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual([
      0, 1, 127, 128, 255,
    ])
  })

  it("handles buffers larger than the fromCharCode chunk size", () => {
    const bytes = new Uint8Array(20000).map((_, i) => i % 256)
    expect(base64ToBytes(bytesToBase64(bytes)).length).toBe(20000)
  })
})

describe("coalescePcmChunks", () => {
  it("returns null for an empty queue", () => {
    expect(coalescePcmChunks([])).toBeNull()
    expect(coalescePcmChunks(null)).toBeNull()
  })

  it("merges consecutive chunks preserving sample order", () => {
    const out = coalescePcmChunks([chunkOf([1, 2]), chunkOf([3, 4]), chunkOf([5])])
    expect(samplesOf(out.base64Data)).toEqual([1, 2, 3, 4, 5])
    expect(out.mergedCount).toBe(3)
    expect(out.droppedSamples).toBe(0)
  })

  it("loses no audio when merging — that is the whole point", () => {
    const out = coalescePcmChunks([chunkOf([0.5, -0.5]), chunkOf([0.25])])
    expect(samplesOf(out.base64Data).length).toBe(3)
  })

  it("marks the merge final when the LAST chunk ends an utterance", () => {
    expect(coalescePcmChunks([chunkOf([1], false), chunkOf([2], true)]).final).toBe(true)
    expect(coalescePcmChunks([chunkOf([1], true), chunkOf([2], false)]).final).toBe(false)
  })

  it("keeps the newest audio when the ceiling is exceeded", () => {
    const out = coalescePcmChunks([chunkOf([1, 2, 3]), chunkOf([4, 5, 6])], {
      maxSamples: 4,
    })
    expect(samplesOf(out.base64Data)).toEqual([3, 4, 5, 6])
    expect(out.droppedSamples).toBe(2)
  })

  it("does not drop anything while under the ceiling", () => {
    const out = coalescePcmChunks([chunkOf([1, 2])], { maxSamples: 10 })
    expect(out.droppedSamples).toBe(0)
    expect(samplesOf(out.base64Data)).toEqual([1, 2])
  })

  it("keeps samples aligned when truncating", () => {
    const out = coalescePcmChunks([chunkOf([1, 2, 3, 4, 5])], { maxSamples: 3 })
    // Still a whole number of Float32 samples, never a split frame.
    expect(base64ToBytes(out.base64Data).length % 4).toBe(0)
    expect(samplesOf(out.base64Data)).toEqual([3, 4, 5])
  })
})

describe("drainQueue", () => {
  it("empties the queue and returns one merged chunk", () => {
    const queue = [chunkOf([1]), chunkOf([2], true)]
    const out = drainQueue(queue)
    expect(queue.length).toBe(0)
    expect(samplesOf(out.base64Data)).toEqual([1, 2])
    expect(out.final).toBe(true)
  })

  it("returns null for an empty queue and leaves it alone", () => {
    const queue = []
    expect(drainQueue(queue)).toBeNull()
    expect(queue.length).toBe(0)
  })

  it("bounds the queue so backlog cannot grow without limit", () => {
    // 10 chunks of 100 samples pile up while the pipeline was busy.
    const queue = Array.from({ length: 10 }, () => chunkOf(new Array(100).fill(1)))
    const out = drainQueue(queue, { maxSamples: 250 })
    expect(queue.length).toBe(0)
    expect(out.mergedCount).toBe(10)
    expect(samplesOf(out.base64Data).length).toBe(250)
    expect(out.droppedSamples).toBe(750)
  })
})
