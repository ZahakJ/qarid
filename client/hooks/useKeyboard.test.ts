/**
 * `logicalKey` — the reason every shortcut in قريض works on an Arabic keyboard.
 *
 * The keymap (client/data/shortcuts.ts) is written in Latin letters because
 * that is what is printed on the keycaps, not because the reader is expected to
 * be on a Latin layout. On the Arabic layout this product's readers actually
 * use, the physical J emits «ت», G emits «ل», P emits «ح» and Shift+/ emits
 * «؟» — so matching `e.key` alone fired nothing at all.
 */
import { describe, expect, it } from "vitest"
import { logicalKey } from "./useKeyboard.ts"

function key(k: string, code: string, shiftKey = false) {
  return logicalKey({ key: k, code, shiftKey })
}

describe("logicalKey", () => {
  it("passes ASCII through untouched — a Latin layout is already correct", () => {
    expect(key("j", "KeyJ")).toBe("j")
    expect(key("g", "KeyG")).toBe("g")
    expect(key("/", "Slash")).toBe("/")
    expect(key("?", "Slash", true)).toBe("?")
  })

  it("passes named keys through — they are layout-independent already", () => {
    expect(key("Escape", "Escape")).toBe("Escape")
    expect(key("Enter", "Enter")).toBe("Enter")
    expect(key("ArrowLeft", "ArrowLeft")).toBe("ArrowLeft")
  })

  it("maps the Arabic layout back onto the keycap the map is written in", () => {
    expect(key("ت", "KeyJ")).toBe("j")
    expect(key("ن", "KeyK")).toBe("k")
    expect(key("ل", "KeyG")).toBe("g")
    expect(key("ح", "KeyP")).toBe("p")
    expect(key("ب", "KeyF")).toBe("f")
    expect(key("ه", "KeyI")).toBe("i")
  })

  it("maps «؟» and «،» back onto the punctuation keys they share", () => {
    expect(key("؟", "Slash", true)).toBe("?")
    expect(key("ظ", "Slash")).toBe("/")
    expect(key("و", "Comma")).toBe(",")
  })

  it("keeps Shift meaningful on a letter", () => {
    expect(key("ت", "KeyJ", true)).toBe("J")
    expect(key("J", "KeyJ", true)).toBe("J")
  })

  it("gives up gracefully on a key it cannot place", () => {
    expect(key("ء", "IntlBackslash")).toBe("ء")
  })
})
