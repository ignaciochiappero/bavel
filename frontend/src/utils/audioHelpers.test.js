import { describe, it, expect } from "vitest"
import { getMergedSamples, resample, blobToBase64 } from "./audioHelpers"

describe("getMergedSamples", () => {
  it("concatenates chunks in order", () => {
    const merged = getMergedSamples([
      new Float32Array([1, 2, 3]),
      new Float32Array([4, 5]),
    ])
    expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5])
  })

  it("returns empty buffer for no chunks", () => {
    expect(getMergedSamples([]).length).toBe(0)
  })
})

describe("resample", () => {
  it("returns the buffer unchanged when rates match", () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(resample(input, 16000, 16000)).toBe(input)
  })

  it("halves the length when downsampling 16k -> 8k", () => {
    const input = new Float32Array(480)
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 10)
    const out = resample(input, 16000, 8000)
    expect(out.length).toBe(240)
  })

  it("produces finite samples", () => {
    const input = new Float32Array(1000)
    for (let i = 0; i < input.length; i++) input[i] = Math.random()
    const out = resample(input, 48000, 16000)
    for (const s of out) expect(Number.isFinite(s)).toBe(true)
  })

  it("handles the last sample without an out-of-bounds next index", () => {
    const input = new Float32Array([1, 2])
    const out = resample(input, 8000, 16000)
    expect(out.length).toBe(4)
    expect(Number.isFinite(out[3])).toBe(true)
  })
})

describe("blobToBase64", () => {
  it("strips the data-url prefix", async () => {
    const blob = new Blob(["hello"])
    const b64 = await blobToBase64(blob)
    expect(b64).toBe(btoa("hello"))
  })
})
