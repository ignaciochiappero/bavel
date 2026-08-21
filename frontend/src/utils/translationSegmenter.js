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

// Emission policy for streaming translation.
//
// LocalAgreement tells us WHICH words are stable; it does not tell us WHEN we
// have enough of them to translate. Sending every confirmed word to the LLM
// would mean one request per word and mutually incoherent translations, so we
// buffer confirmed text and release it only at a clause boundary.
//
// Rules, in order:
//   1. A strong boundary (. ! ? …) with at least `minWords` buffered releases
//      everything up to the LAST strong boundary — the largest closed unit
//      available, which gives the translator the most context per request.
//   2. Otherwise, once `maxWords` piles up, fall back to the last weak
//      boundary (, ; :), or to a hard cut at `maxWords` if there is none.
//      This bounds how long an unpunctuated monologue can stall a release.
//   3. Otherwise, wait for more words.
//
// Note: abbreviations ("Sr.", "etc.") are treated as sentence ends. That is
// acceptable here because the input is speech transcription, where the
// recognizer rarely emits them.

const STRONG_BOUNDARY = /[.!?…]["'”’)\]]*$/
const WEAK_BOUNDARY = /[,;:]["'”’)\]]*$/

export function isStrongBoundary(token) {
  return STRONG_BOUNDARY.test(token)
}

export function isWeakBoundary(token) {
  return WEAK_BOUNDARY.test(token)
}

// Index of the last token matching `predicate`, or -1.
function lastBoundaryIndex(tokens, predicate) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (predicate(tokens[i])) return i
  }
  return -1
}

export function createTranslationSegmenter({ minWords = 5, maxWords = 24 } = {}) {
  if (minWords < 1) throw new Error("minWords must be >= 1")
  if (maxWords < minWords) throw new Error("maxWords must be >= minWords")

  let buffer = []

  // Returns how many leading tokens are ready to be released, or 0.
  const releasableCount = () => {
    if (buffer.length === 0) return 0

    const strong = lastBoundaryIndex(buffer, isStrongBoundary)
    if (strong >= 0 && strong + 1 >= minWords) return strong + 1

    if (buffer.length >= maxWords) {
      const weak = lastBoundaryIndex(buffer.slice(0, maxWords), isWeakBoundary)
      if (weak >= 0 && weak + 1 >= minWords) return weak + 1
      return maxWords
    }
    return 0
  }

  return {
    // Feed newly confirmed text. Returns the segments ready to translate
    // (usually zero or one, more only if a long burst arrives at once).
    push(text) {
      const tokens = String(text || "").trim().split(/\s+/).filter(Boolean)
      if (tokens.length > 0) buffer = buffer.concat(tokens)

      const segments = []
      let count = releasableCount()
      while (count > 0) {
        segments.push(buffer.slice(0, count).join(" "))
        buffer = buffer.slice(count)
        count = releasableCount()
      }
      return segments
    },

    // End of utterance: release whatever is left regardless of boundaries.
    flush() {
      if (buffer.length === 0) return []
      const rest = buffer.join(" ")
      buffer = []
      return [rest]
    },

    reset() {
      buffer = []
    },

    // Confirmed text still waiting for a boundary.
    get buffered() {
      return buffer.join(" ")
    },
  }
}
