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

import React, { useState, useEffect, useRef } from "react"
import { Menu, X } from "lucide-react"
import Tooltip, { useTooltipTilt } from "./Tooltip"

// Actions that fan out from a single trigger.
//
// The gooey blob layer was removed on purpose. That effect needs OPAQUE
// shapes to melt into one another, and dialling their opacity down far enough
// to sit politely on a glass panel turns the merge into a diffuse halo around
// every icon — the two looks cannot be had at once. Glass won: each action is
// a real translucent surface matching the rest of the interface, and the
// liquid quality now lives in the MOTION, not in the fill.
// The fan sweeps clockwise from 6 o'clock to 9 o'clock — the lower-left
// quadrant. On screen, where Y grows downward, that is 90deg (straight down)
// to 180deg (straight left).
//
// Four buttons across the quadrant leaves 30deg between neighbours, so 96px
// of travel already gives them ~10px of air. (With five it took 124px, which
// swallowed a lot more of the transcript while open.)
const BLOB = 40 // button diameter, px
const RADIUS = 96 // travel distance
const ARC_FROM = 90 // 6 o'clock — straight down
const ARC_TO = 180 // 9 o'clock — straight left

// Polar placement, because the fan is what the effect is FOR: neighbours stay
// within reach of each other the whole way out.
function offsetFor(i, count) {
  if (count === 1) return { x: 0, y: RADIUS }
  const t = i / (count - 1)
  const deg = ARC_FROM + (ARC_TO - ARC_FROM) * t
  const rad = (deg * Math.PI) / 180
  return { x: Math.cos(rad) * RADIUS, y: Math.sin(rad) * RADIUS }
}

export default function LiquidMenu({ items = [] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  // One tilt for the whole menu: only one item can be hovered at a time.
  const { tilt, tiltHandlers } = useTooltipTilt()

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const place = (i) => {
    if (!open) return "translate(0px, 0px)"
    const { x, y } = offsetFor(i, items.length)
    return `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
  }

  // Opening peels outward, closing pulls back in reverse order.
  const delay = (i) => `${open ? i * 45 : (items.length - 1 - i) * 35}ms`

  return (
    <div
      className="liquid-menu"
      data-open={open ? "true" : "false"}
      ref={rootRef}
      style={{ "--blob": `${BLOB}px` }}
    >
      <div className="liquid-items">
        {items.map((item, i) => (
          <button
            key={item.key ?? i}
            className={`liquid-item ${item.active ? "active" : ""}`}
            style={{ transform: place(i), transitionDelay: delay(i) }}
            onClick={() => {
              item.onClick?.()
              setOpen(false)
            }}
            disabled={item.disabled}
            aria-label={item.label}
            tabIndex={open ? 0 : -1}
            aria-hidden={open ? "false" : "true"}
            {...tiltHandlers}
          >
            {item.icon}
            <Tooltip label={item.label} tilt={tilt} placement="left" />
          </button>
        ))}

        <button
          className="liquid-item liquid-trigger"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Cerrar acciones" : "Acciones"}
        >
          {open ? (
            <X size={17} strokeWidth={1.75} />
          ) : (
            <Menu size={17} strokeWidth={1.75} />
          )}
        </button>
      </div>
    </div>
  )
}
