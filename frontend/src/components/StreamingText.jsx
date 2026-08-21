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

import React from "react"

// Renders a live transcript so new words fade in as they arrive instead of
// appearing in blocks.
//
// The animation rides on React's own reconciliation: each word is a keyed
// <span>, so words already on screen are NOT remounted when more text
// arrives — only the new spans mount, and only they run the entry animation.
// No timers, no per-frame JavaScript, no re-animating the paragraph.
//
// Only the tail is split into spans. A long conversation would otherwise grow
// a DOM node per word forever; everything older than `animateTail` words
// collapses into one plain text node that never animates again.
const DEFAULT_TAIL = 40

function Words({ text, offset, className }) {
  const words = text.split(/\s+/).filter(Boolean)
  return words.map((word, i) => (
    <span
      key={`${offset + i}-${word}`}
      className={className}
      // Stagger so a burst of words ripples in rather than flashing at once.
      // Capped, or a long release would leave the last words lagging.
      style={{ animationDelay: `${Math.min(i * 28, 260)}ms` }}
    >
      {offset + i > 0 || i > 0 ? " " : ""}
      {word}
    </span>
  ))
}

export default function StreamingText({
  text = "",
  pending = "",
  isLive = false,
  animateTail = DEFAULT_TAIL,
}) {
  const all = text.split(/\s+/).filter(Boolean)
  const splitAt = Math.max(0, all.length - animateTail)
  // Settled text: one plain node, no spans, never re-animated.
  const settled = all.slice(0, splitAt).join(" ")
  const tail = all.slice(splitAt).join(" ")

  if (!text && !pending) return "—"

  return (
    <>
      {settled}
      {settled && tail ? " " : ""}
      {tail && <Words text={tail} offset={splitAt} className="word-in" />}
      {pending && (
        <Words
          text={pending}
          offset={all.length}
          className="word-in doc-text-pending"
        />
      )}
      {isLive && <span className="live-caret" />}
    </>
  )
}
