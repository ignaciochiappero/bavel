import { describe, it, expect } from "vitest"
import {
  createTranslationSegmenter,
  isStrongBoundary,
  isWeakBoundary,
} from "./translationSegmenter"

describe("boundary detection", () => {
  it("detects sentence-ending punctuation", () => {
    expect(isStrongBoundary("estás.")).toBe(true)
    expect(isStrongBoundary("estás?")).toBe(true)
    expect(isStrongBoundary("estás!")).toBe(true)
    expect(isStrongBoundary("estás")).toBe(false)
  })

  it("detects clause punctuation", () => {
    expect(isWeakBoundary("hola,")).toBe(true)
    expect(isWeakBoundary("mira;")).toBe(true)
    expect(isWeakBoundary("hola")).toBe(false)
  })

  it("looks through trailing quotes and brackets", () => {
    expect(isStrongBoundary('dijo."')).toBe(true)
    expect(isWeakBoundary("dijo,'")).toBe(true)
  })
})

describe("createTranslationSegmenter", () => {
  it("holds text until a boundary appears", () => {
    const seg = createTranslationSegmenter({ minWords: 3, maxWords: 20 })
    expect(seg.push("hola cómo estás")).toEqual([])
    expect(seg.buffered).toBe("hola cómo estás")
  })

  it("releases on a strong boundary once minWords is met", () => {
    const seg = createTranslationSegmenter({ minWords: 3, maxWords: 20 })
    expect(seg.push("hola cómo estás.")).toEqual(["hola cómo estás."])
    expect(seg.buffered).toBe("")
  })

  it("does not release a strong boundary below minWords", () => {
    const seg = createTranslationSegmenter({ minWords: 5, maxWords: 20 })
    expect(seg.push("hola.")).toEqual([])
    expect(seg.buffered).toBe("hola.")
  })

  it("releases up to the LAST strong boundary for maximum context", () => {
    const seg = createTranslationSegmenter({ minWords: 2, maxWords: 30 })
    // Two closed sentences arrive together — released as one unit.
    expect(seg.push("hola qué tal. todo bien por acá. y vos")).toEqual([
      "hola qué tal. todo bien por acá.",
    ])
    expect(seg.buffered).toBe("y vos")
  })

  it("falls back to a weak boundary once maxWords is exceeded", () => {
    const seg = createTranslationSegmenter({ minWords: 2, maxWords: 6 })
    const out = seg.push("uno dos, tres cuatro cinco seis siete")
    expect(out).toEqual(["uno dos,"])
    expect(seg.buffered).toBe("tres cuatro cinco seis siete")
  })

  it("hard-cuts at maxWords when there is no punctuation at all", () => {
    const seg = createTranslationSegmenter({ minWords: 2, maxWords: 4 })
    const out = seg.push("uno dos tres cuatro cinco seis")
    expect(out).toEqual(["uno dos tres cuatro"])
    expect(seg.buffered).toBe("cinco seis")
  })

  it("accumulates across several pushes", () => {
    const seg = createTranslationSegmenter({ minWords: 4, maxWords: 20 })
    expect(seg.push("hola")).toEqual([])
    expect(seg.push("cómo")).toEqual([])
    expect(seg.push("estás")).toEqual([])
    expect(seg.push("amigo.")).toEqual(["hola cómo estás amigo."])
  })

  it("releases several segments when a long burst arrives at once", () => {
    const seg = createTranslationSegmenter({ minWords: 2, maxWords: 4 })
    const out = seg.push("uno dos tres cuatro cinco seis siete ocho nueve")
    expect(out).toEqual(["uno dos tres cuatro", "cinco seis siete ocho"])
    expect(seg.buffered).toBe("nueve")
  })

  it("flushes the remainder regardless of boundaries", () => {
    const seg = createTranslationSegmenter({ minWords: 5, maxWords: 20 })
    seg.push("hola cómo")
    expect(seg.flush()).toEqual(["hola cómo"])
    expect(seg.buffered).toBe("")
  })

  it("flushes to nothing when the buffer is empty", () => {
    expect(createTranslationSegmenter().flush()).toEqual([])
  })

  it("ignores empty pushes", () => {
    const seg = createTranslationSegmenter({ minWords: 2, maxWords: 10 })
    expect(seg.push("")).toEqual([])
    expect(seg.push("   ")).toEqual([])
    expect(seg.buffered).toBe("")
  })

  it("resets its buffer", () => {
    const seg = createTranslationSegmenter()
    seg.push("hola cómo")
    seg.reset()
    expect(seg.buffered).toBe("")
  })

  it("rejects an invalid configuration", () => {
    expect(() => createTranslationSegmenter({ minWords: 0 })).toThrow()
    expect(() => createTranslationSegmenter({ minWords: 10, maxWords: 4 })).toThrow()
  })
})
