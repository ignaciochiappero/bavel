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

import React, { useEffect, useRef } from "react"

// Liquid level meter sitting under the language lanes.
//
// Draws soft round-capped columns rather than rectangles: the #liquid SVG
// filter (see index.html) blurs the canvas and crushes its alpha, so rounded
// neighbours bleed into one another and read as a single body of fluid.
// Square bars would just come back square, which is why the shape matters.
//
// Colour is read from the --accent custom property so the theme picker keeps
// working, and it is re-read on every mount rather than hard-coded.
export default function Visualizer({
  activePerson,
  isRecording,
  analyser,
  barsCount,
}) {
  const canvas1Ref = useRef(null)
  const canvas2Ref = useRef(null)
  const animationRef = useRef(null)

  useEffect(() => {
    const canvas1 = canvas1Ref.current
    const canvas2 = canvas2Ref.current
    if (!canvas1 || !canvas2) return
    const ctx1 = canvas1.getContext("2d")
    const ctx2 = canvas2.getContext("2d")

    const styles = getComputedStyle(document.documentElement)
    const accent = (styles.getPropertyValue("--accent") || "#6c8cff").trim()

    const numBars = Math.max(6, parseInt(barsCount, 10) || 24)

    // One column, as a round-capped line so the filter has curves to melt.
    const column = (ctx, x, w, h, height, alpha) => {
      const r = Math.min(w / 2, 5)
      ctx.globalAlpha = alpha
      ctx.strokeStyle = accent
      ctx.lineWidth = w
      ctx.lineCap = "round"
      ctx.beginPath()
      ctx.moveTo(x + w / 2, height - r)
      ctx.lineTo(x + w / 2, Math.max(r, height - h))
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Idle: a low, even ripple so the meter never looks dead.
    const drawIdle = (ctx, canvas) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const gap = 3
      const w = canvas.width / numBars - gap
      for (let i = 0; i < numBars; i++) {
        column(ctx, i * (w + gap), w, 3, canvas.height, 0.28)
      }
    }

    if (!isRecording || !analyser) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
      drawIdle(ctx1, canvas1)
      drawIdle(ctx2, canvas2)
      return
    }

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    // Speech lives in the lower spectrum; the top quarter is mostly empty.
    const maxBin = Math.floor(bufferLength * 0.75)
    const binsPerBar = Math.max(1, Math.floor(maxBin / numBars))

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)

      const activeCtx = activePerson === 1 ? ctx1 : ctx2
      const activeCanvas = activePerson === 1 ? canvas1 : canvas2
      const inactiveCtx = activePerson === 1 ? ctx2 : ctx1
      const inactiveCanvas = activePerson === 1 ? canvas2 : canvas1

      drawIdle(inactiveCtx, inactiveCanvas)

      activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height)
      const gap = 3
      const w = activeCanvas.width / numBars - gap

      for (let i = 0; i < numBars; i++) {
        let sum = 0
        for (let j = 0; j < binsPerBar; j++) {
          sum += dataArray[i * binsPerBar + j]
        }
        const average = sum / binsPerBar
        const h = Math.max(3, (average / 255) * (activeCanvas.height - 6))
        column(activeCtx, i * (w + gap), w, h, activeCanvas.height, 0.95)
      }
    }

    draw()

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
    }
  }, [isRecording, analyser, barsCount, activePerson])

  return (
    <section className="visualizer-divider" style={{ display: "flex", gap: "12px" }}>
      <div className="canvas-wrap" style={{ flex: 1 }}>
        <canvas ref={canvas1Ref} width="480" height="92" />
      </div>
      <div className="canvas-wrap" style={{ flex: 1 }}>
        <canvas ref={canvas2Ref} width="480" height="92" />
      </div>
    </section>
  )
}
