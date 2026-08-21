import { describe, it, expect } from "vitest"
import { DEFAULT_ACCENT, NEUTRAL_ACCENT, isLegacyAccent } from "./theme"

describe("theme accents", () => {
  it("exposes a default and a neutral accent", () => {
    expect(DEFAULT_ACCENT).toMatch(/^#[0-9a-f]{6}$/i)
    expect(NEUTRAL_ACCENT).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it("keeps the neutral accent actually neutral", () => {
    // Equal channels: any spread would tint the greys it is meant to remove.
    const [r, g, b] = [1, 3, 5].map((i) =>
      parseInt(NEUTRAL_ACCENT.slice(i, i + 2), 16),
    )
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2)
  })

  it("flags accents from the old kiosk theme", () => {
    expect(isLegacyAccent("#ffa500")).toBe(true)
    expect(isLegacyAccent("#FFA500")).toBe(true) // case-insensitive
    expect(isLegacyAccent("#2196f3")).toBe(true)
  })

  it("leaves current accents alone", () => {
    expect(isLegacyAccent(DEFAULT_ACCENT)).toBe(false)
    expect(isLegacyAccent(NEUTRAL_ACCENT)).toBe(false)
  })

  it("treats missing values as not legacy", () => {
    expect(isLegacyAccent(null)).toBe(false)
    expect(isLegacyAccent("")).toBe(false)
  })
})

describe("neutral as the default", () => {
  it("defaults to the neutral accent", () => {
    expect(DEFAULT_ACCENT).toBe(NEUTRAL_ACCENT)
  })

  it("migrates iris, which was the previous default rather than a choice", () => {
    expect(isLegacyAccent("#6c8cff")).toBe(true)
  })

  it("still leaves deliberately-picked accents alone", () => {
    // Every other swatch in the picker must survive a reload.
    ;["#4fd1a5", "#ff7ac6", "#a78bfa", "#ffb454", "#7dd3fc"].forEach((c) =>
      expect(isLegacyAccent(c)).toBe(false),
    )
  })
})
