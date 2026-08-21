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

// Accent identity, shared by the picker and the shell so neither has to
// hard-code hexes the other also knows.



// The neutral theme, and the default. Picking it does something no other
// swatch does: it also drains the colour from the aurora behind the panels,
// leaving the interface in greys. Kept here because both the picker (to offer
// it) and App (to set the data attribute CSS keys off) need to agree on the
// exact value.
//
// Equal channels — #a1a1aa (zinc) carries 9 points of extra blue, which tints
// the very greys this theme exists to remove.
export const NEUTRAL_ACCENT = "#a3a3a3"

export const DEFAULT_ACCENT = NEUTRAL_ACCENT

// Accents from the old high-contrast kiosk theme. They were chosen for a light
// orange ground and clash with the dark glass one, so a stored value from that
// era is migrated to the current default instead of being honoured.
const LEGACY_ACCENTS = new Set([
  "#ffa500",
  "#ff4444",
  "#ffffff",
  "#ffeb3b",
  "#2196f3",
  "#4caf50",
  // Iris was the previous default, written to storage on first load rather
  // than chosen, so it migrates too. It stays in the picker for anyone who
  // wants it deliberately.
  "#6c8cff",
])

export function isLegacyAccent(value) {
  return Boolean(value) && LEGACY_ACCENTS.has(String(value).toLowerCase())
}
