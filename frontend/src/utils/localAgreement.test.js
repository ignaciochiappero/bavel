import { describe, it, expect } from "vitest"
import { tokenize, commonPrefix, createLocalAgreement } from "./localAgreement"

describe("tokenize", () => {
  it("splits on whitespace and drops empties", () => {
    expect(tokenize("  hola   cómo estás ")).toEqual(["hola", "cómo", "estás"])
  })

  it("returns an empty array for empty input", () => {
    expect(tokenize("")).toEqual([])
    expect(tokenize(null)).toEqual([])
  })

  it("keeps punctuation attached to the token", () => {
    expect(tokenize("hola, qué tal")).toEqual(["hola,", "qué", "tal"])
  })
})

describe("commonPrefix", () => {
  it("returns the longest shared prefix", () => {
    expect(commonPrefix([["a", "b", "c"], ["a", "b", "d"]])).toEqual(["a", "b"])
  })

  it("returns nothing when the first token already differs", () => {
    expect(commonPrefix([["a"], ["b"]])).toEqual([])
  })

  it("is bounded by the shortest list", () => {
    expect(commonPrefix([["a", "b"], ["a", "b", "c"]])).toEqual(["a", "b"])
  })

  it("returns an empty prefix for no lists", () => {
    expect(commonPrefix([])).toEqual([])
  })
})

describe("createLocalAgreement", () => {
  it("commits nothing on the first hypothesis", () => {
    const la = createLocalAgreement()
    const r = la.update("hola como estas")
    expect(r.committed).toBe("")
    expect(r.pending).toBe("hola como estas")
  })

  it("commits only the prefix two hypotheses agree on", () => {
    const la = createLocalAgreement()
    la.update("hola como estas")
    const r = la.update("hola cómo estás amigo")
    // "como" was revised to "cómo", so only "hola" is stable.
    expect(r.committed).toBe("hola")
    expect(r.pending).toBe("cómo estás amigo")
    expect(r.newlyCommitted).toBe("hola")
  })

  it("grows the committed prefix as hypotheses stabilize", () => {
    const la = createLocalAgreement()
    la.update("hola como estas")
    la.update("hola cómo estás amigo")
    const r = la.update("hola cómo estás amigo mío")
    expect(r.committed).toBe("hola cómo estás amigo")
    expect(r.pending).toBe("mío")
  })

  it("never revises committed text when the recognizer contradicts it", () => {
    const la = createLocalAgreement()
    la.update("hola cómo estás")
    la.update("hola cómo estás")
    expect(la.text).toBe("hola cómo estás")

    // The recognizer changes its mind about already-confirmed words. Those
    // three tokens describe the same audio, so there is nothing NEW in this
    // hypothesis — committed text stands and nothing is re-emitted.
    const r = la.update("hola qué tal")
    expect(r.committed).toBe("hola cómo estás")
    expect(r.pending).toBe("")
  })

  it("does not re-emit the transcript when the recognizer revises far back", () => {
    // Reproduces the real Moonshine behaviour measured against the running
    // stack: punctuation early in the transcript is rewritten once more audio
    // arrives. Before the positional fix this duplicated everything after the
    // divergence point.
    const la = createLocalAgreement()
    const h1 = "Good morning, everyone. Thanks for joining"
    la.update(h1)
    la.update(h1)
    expect(la.text).toBe(h1)

    // Same words, re-punctuated at the START, plus two genuinely new tokens.
    const r = la.update("Good morning. Everyone thanks for joining the call")
    expect(r.committed).toBe(h1) // untouched
    expect(r.pending).toBe("the call") // only the new tail
    // "Thanks for joining" must NOT appear a second time anywhere.
    expect(`${r.committed} ${r.pending}`).toBe(
      "Good morning, everyone. Thanks for joining the call",
    )
  })

  it("ignores a hypothesis that shrinks below the committed length", () => {
    const la = createLocalAgreement()
    la.update("uno dos tres")
    la.update("uno dos tres")
    const r = la.update("uno dos")
    expect(r.committed).toBe("uno dos tres")
    expect(r.pending).toBe("")
  })

  it("respects a larger n (more agreement required, more lag)", () => {
    const la = createLocalAgreement({ n: 3 })
    expect(la.update("uno dos").committed).toBe("")
    expect(la.update("uno dos").committed).toBe("")
    expect(la.update("uno dos tres").committed).toBe("uno dos")
  })

  it("rejects n < 2", () => {
    expect(() => createLocalAgreement({ n: 1 })).toThrow()
  })

  it("commits the pending tail on flush", () => {
    const la = createLocalAgreement()
    la.update("hola como")
    la.update("hola cómo estás")
    const r = la.flush()
    expect(r.pending).toBe("")
    expect(la.text).toBe("hola cómo estás")
  })

  it("prefers the final transcript passed to flush", () => {
    const la = createLocalAgreement()
    la.update("hola como")
    la.update("hola cómo estás")
    la.flush("hola cómo estás amigo")
    expect(la.text).toBe("hola cómo estás amigo")
  })

  it("does not duplicate committed words when flushing a full final text", () => {
    const la = createLocalAgreement()
    la.update("uno dos")
    la.update("uno dos")
    expect(la.text).toBe("uno dos")
    la.flush("uno dos tres")
    expect(la.text).toBe("uno dos tres")
  })

  it("resets back to an empty state", () => {
    const la = createLocalAgreement()
    la.update("hola")
    la.update("hola")
    la.reset()
    expect(la.text).toBe("")
    expect(la.update("otra cosa").committed).toBe("")
  })

  it("handles an empty hypothesis without committing anything", () => {
    const la = createLocalAgreement()
    expect(la.update("").committed).toBe("")
    expect(la.update("").committed).toBe("")
    expect(la.text).toBe("")
  })
})
