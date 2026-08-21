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

// LocalAgreement-n confirmation policy (Macháček et al., "Turning Whisper
// into Real-Time Transcription System", arXiv:2307.14743).
//
// An incremental recognizer emits a full hypothesis on every update and is
// free to REVISE what it said before:
//
//   update 1: "hola como estas"
//   update 2: "hola cómo estás amigo"     <- revised "como" -> "cómo"
//   update 3: "hola cómo estás amigo mío"
//
// Rendering the raw latest hypothesis makes the text flicker. LocalAgreement-n
// only commits the prefix that the last n hypotheses agree on; committed text
// is immutable from then on. Everything after it stays "pending" and may still
// change, so the UI can render it differently.
//
// The cost is exactly one update of extra latency (with n = 2): a word is
// confirmed only once a second hypothesis has repeated it.

// Splits on whitespace. Tokens keep their punctuation, so "hola" and "hola,"
// are different tokens — a punctuation change IS a revision and must block
// confirmation.
export function tokenize(text) {
  if (!text) return []
  return String(text).trim().split(/\s+/).filter(Boolean)
}

// Longest common prefix of a list of token arrays.
export function commonPrefix(tokenLists) {
  if (tokenLists.length === 0) return []
  const shortest = tokenLists.reduce(
    (min, list) => Math.min(min, list.length),
    Infinity,
  )
  const prefix = []
  for (let i = 0; i < shortest; i++) {
    const token = tokenLists[0][i]
    if (tokenLists.every((list) => list[i] === token)) prefix.push(token)
    else break
  }
  return prefix
}

// Creates a stateful aggregator for ONE stream. Feed it every hypothesis the
// recognizer returns; it hands back the stable prefix and the tentative tail.
export function createLocalAgreement({ n = 2 } = {}) {
  if (n < 2) throw new Error("LocalAgreement needs n >= 2")

  let committed = [] // confirmed tokens — never revised
  let history = [] // last n hypotheses, each stripped of the committed prefix

  // Drops the already-committed prefix from a fresh hypothesis, BY POSITION.
  //
  // Measured against the real recognizer, Moonshine does not only revise near
  // the end: given more audio it rewrites punctuation and capitalisation far
  // back in the transcript ("Good morning, everyone. Thanks for joining" ->
  // "Good morning. Everyone thanks for joining", eight chunks later). Resuming
  // from the first diverging token there re-emits the entire rest of the
  // transcript, which showed up as duplicated and garbled segments.
  //
  // The hypothesis always describes the same cumulative audio, so its first
  // `committed.length` tokens are the words we already emitted — whatever the
  // recognizer now thinks they should look like. Only what comes after that
  // position is genuinely new. Slicing positionally keeps the "committed text
  // is immutable" guarantee AND makes a late global revision a no-op instead
  // of a corruption.
  const stripCommitted = (tokens) => tokens.slice(committed.length)

  const snapshot = (pendingTokens, newlyCommitted) => ({
    committed: committed.join(" "),
    pending: pendingTokens.join(" "),
    newlyCommitted: newlyCommitted.join(" "),
  })

  return {
    // Feed one hypothesis (the recognizer's full text so far).
    update(text) {
      const rest = stripCommitted(tokenize(text))

      history.push(rest)
      if (history.length > n) history.shift()

      // Not enough hypotheses to agree on anything yet.
      if (history.length < n) return snapshot(rest, [])

      const agreed = commonPrefix(history)
      if (agreed.length > 0) {
        committed = committed.concat(agreed)
        // Re-base the window so the next comparison only sees unconfirmed text.
        history = history.map((h) => h.slice(agreed.length))
      }
      return snapshot(history[history.length - 1], agreed)
    },

    // End of stream: the final transcript is authoritative, so everything
    // still pending is committed. Pass the recognizer's final text when it is
    // available, otherwise the last pending tail is used.
    flush(finalText) {
      const tail =
        finalText === undefined || finalText === null
          ? history.length > 0
            ? history[history.length - 1]
            : []
          : stripCommitted(tokenize(finalText))
      committed = committed.concat(tail)
      history = []
      return snapshot([], tail)
    },

    reset() {
      committed = []
      history = []
    },

    // Current stable text, for callers that only need the confirmed prefix.
    get text() {
      return committed.join(" ")
    },
  }
}
