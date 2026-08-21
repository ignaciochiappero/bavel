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

import { useEffect, useRef } from "react"

// Drives a `--audio-level` custom property (0..1) on an element from live
// microphone or tab audio, so a panel can glow with whoever is speaking.
//
// The level is written STRAIGHT TO THE DOM rather than kept in React state.
// State would re-render the whole translator sixty times a second — while the
// speech models are already competing for the CPU — to move one shadow. A
// custom property changes only what the compositor draws.
const SMOOTHING = 0.18
// Voice rarely fills the byte range, so raw averages hover low and the glow
// would barely move. This lifts the useful part of the range.
const GAIN = 2.6

export function useAudioGlow({ analyser, active, targets }) {
  // Kept across frames so the glow eases instead of strobing on every peak.
  const levelRef = useRef(0)
  const frameRef = useRef(null)

  useEffect(() => {
    const clear = () => {
      Object.values(targets || {}).forEach((el) =>
        el?.style?.setProperty("--audio-level", "0"),
      )
    }

    if (!analyser || !active) {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      levelRef.current = 0
      clear()
      return
    }

    const data = new Uint8Array(analyser.frequencyBinCount)
    // Speech lives low in the spectrum; including the empty top drags the
    // average down and flattens the response.
    const usable = Math.floor(data.length * 0.6)

    const tick = () => {
      frameRef.current = requestAnimationFrame(tick)
      analyser.getByteFrequencyData(data)

      let sum = 0
      for (let i = 0; i < usable; i++) sum += data[i]
      const raw = Math.min(1, (sum / usable / 255) * GAIN)
      levelRef.current += (raw - levelRef.current) * SMOOTHING

      const value = levelRef.current.toFixed(3)
      Object.entries(targets || {}).forEach(([lane, el]) => {
        if (!el) return
        // Only the lane that owns the audio lights up; the other stays dark,
        // which is what makes the glow read as "this one is speaking".
        el.style.setProperty("--audio-level", lane === String(active) ? value : "0")
      })
    }

    tick()
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      clear()
    }
  }, [analyser, active, targets])
}
