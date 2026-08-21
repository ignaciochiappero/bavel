import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, cleanup, act } from "@testing-library/react"
import { useAudioGlow } from "./useAudioGlow"

afterEach(cleanup)

function makeTargets() {
  const el = () => document.createElement("div")
  return { 1: el(), 2: el() }
}

function analyserAt(value) {
  return {
    frequencyBinCount: 128,
    getByteFrequencyData: (arr) => arr.fill(value),
  }
}

// The hook drives itself with rAF; capture the callbacks to step frames.
function frameControl() {
  const cbs = []
  vi.stubGlobal("requestAnimationFrame", (cb) => cbs.push(cb))
  vi.stubGlobal("cancelAnimationFrame", () => {})
  return { step: (n = 1) => act(() => { for (let i = 0; i < n && cbs.length; i++) cbs.shift()() }) }
}

const levelOf = (el) => parseFloat(el.style.getPropertyValue("--audio-level"))

describe("useAudioGlow", () => {
  it("leaves both lanes dark with no analyser", () => {
    const targets = makeTargets()
    frameControl()
    renderHook(() => useAudioGlow({ analyser: null, active: 1, targets }))
    expect(levelOf(targets[1])).toBe(0)
    expect(levelOf(targets[2])).toBe(0)
  })

  it("lights only the lane that owns the audio", () => {
    const targets = makeTargets()
    const { step } = frameControl()
    renderHook(() =>
      useAudioGlow({ analyser: analyserAt(220), active: 1, targets }),
    )
    step(20)
    expect(levelOf(targets[1])).toBeGreaterThan(0.3)
    // The silent lane must stay dark — that contrast is the whole signal.
    expect(levelOf(targets[2])).toBe(0)
  })

  it("rises with loudness", () => {
    const quiet = makeTargets()
    const loud = makeTargets()
    let c1 = frameControl()
    renderHook(() => useAudioGlow({ analyser: analyserAt(40), active: 1, targets: quiet }))
    c1.step(20)
    const c2 = frameControl()
    renderHook(() => useAudioGlow({ analyser: analyserAt(240), active: 1, targets: loud }))
    c2.step(20)
    expect(levelOf(loud[1])).toBeGreaterThan(levelOf(quiet[1]))
  })

  it("eases instead of jumping to the first reading", () => {
    const targets = makeTargets()
    const { step } = frameControl()
    renderHook(() => useAudioGlow({ analyser: analyserAt(255), active: 1, targets }))
    step(1)
    const afterOne = levelOf(targets[1])
    step(20)
    // A single frame must not reach the top, or every peak would strobe.
    expect(afterOne).toBeLessThan(levelOf(targets[1]))
  })

  it("clamps at 1 however loud it gets", () => {
    const targets = makeTargets()
    const { step } = frameControl()
    renderHook(() => useAudioGlow({ analyser: analyserAt(255), active: 1, targets }))
    step(80)
    expect(levelOf(targets[1])).toBeLessThanOrEqual(1)
  })

  it("goes dark when capture stops", () => {
    const targets = makeTargets()
    const { step } = frameControl()
    const { rerender } = renderHook(
      ({ active }) => useAudioGlow({ analyser: analyserAt(220), active, targets }),
      { initialProps: { active: 1 } },
    )
    step(20)
    expect(levelOf(targets[1])).toBeGreaterThan(0)
    rerender({ active: null })
    expect(levelOf(targets[1])).toBe(0)
  })

  it("survives a lane element that is not mounted yet", () => {
    const { step } = frameControl()
    expect(() => {
      renderHook(() =>
        useAudioGlow({ analyser: analyserAt(200), active: 1, targets: { 1: null, 2: null } }),
      )
      step(3)
    }).not.toThrow()
  })
})
