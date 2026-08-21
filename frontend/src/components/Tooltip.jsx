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

import React, { useState, useCallback } from "react"

// Tooltip that reveals on hover and tilts toward the pointer.
//
// Two motions on two nested elements, because they need different curves and
// a single element can only transition a property one way:
//
//   outer — the REVEAL: fades and springs up from below with an overshoot,
//           played once when the pointer arrives.
//   inner — the TILT: rotates and slides with the cursor, retargeted on every
//           mousemove, so it needs a short linear-ish curve instead. Sharing
//           one element would make each mouse move restart the entry bounce.
//
// Written with CSS transitions rather than a spring library: this interface
// deliberately keeps animation on the compositor, since the speech models
// already take most of the CPU. A physics runtime would put every frame back
// on the main thread for a hint label.
const MAX_ROTATE = 14 // degrees at the edge of the target
const MAX_SHIFT = 12 // px of travel at the edge

export function useTooltipTilt() {
  const [tilt, setTilt] = useState({ r: 0, x: 0 })

  const onMouseMove = useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    // -1 at the left edge, +1 at the right edge.
    const norm = (event.clientX - rect.left) / rect.width - 0.5
    const clamped = Math.max(-0.5, Math.min(0.5, norm)) * 2
    setTilt({ r: clamped * MAX_ROTATE, x: clamped * MAX_SHIFT })
  }, [])

  // Settle back to centre so the next reveal does not start crooked.
  const onMouseLeave = useCallback(() => setTilt({ r: 0, x: 0 }), [])

  return { tilt, tiltHandlers: { onMouseMove, onMouseLeave } }
}

export default function Tooltip({ label, tilt, placement = "left" }) {
  return (
    <span className={`tip tip-${placement}`} role="tooltip">
      <span
        className="tip-inner"
        style={{
          transform: `translateX(${(tilt?.x ?? 0).toFixed(1)}px) rotate(${(
            tilt?.r ?? 0
          ).toFixed(1)}deg)`,
        }}
      >
        {label}
        {/* Two hairlines that fade out from the centre — the detail that
            keeps the label from reading as a plain box. */}
        <span className="tip-rule tip-rule-a" />
        <span className="tip-rule tip-rule-b" />
      </span>
    </span>
  )
}
