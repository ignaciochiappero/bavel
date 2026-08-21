import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import React from "react"
import Tooltip, { useTooltipTilt } from "./Tooltip"

afterEach(cleanup)

// Harness: a target of known width, so pointer positions map to known tilts.
function Host({ placement = "left" }) {
  const { tilt, tiltHandlers } = useTooltipTilt()
  return (
    <button data-testid="host" {...tiltHandlers}>
      <Tooltip label="Etiqueta" tilt={tilt} placement={placement} />
    </button>
  )
}

const WIDTH = 200
function moveTo(el, clientX) {
  el.getBoundingClientRect = () => ({ left: 0, width: WIDTH, top: 0, height: 40 })
  fireEvent.mouseMove(el, { clientX })
}
const tiltOf = (container) => container.querySelector(".tip-inner").style.transform

describe("Tooltip", () => {
  it("renders the label", () => {
    const { container } = render(<Host />)
    expect(container.querySelector(".tip").textContent).toContain("Etiqueta")
  })

  it("sits level when the pointer is centred", () => {
    const { container, getByTestId } = render(<Host />)
    moveTo(getByTestId("host"), WIDTH / 2)
    expect(tiltOf(container)).toBe("translateX(0.0px) rotate(0.0deg)")
  })

  it("tilts opposite ways on either side of centre", () => {
    const { container, getByTestId } = render(<Host />)
    const host = getByTestId("host")
    moveTo(host, 0)
    const left = tiltOf(container)
    moveTo(host, WIDTH)
    const right = tiltOf(container)
    expect(left).toContain("-")
    expect(right).not.toContain("-")
    expect(left).not.toBe(right)
  })

  it("clamps at the edges instead of running away", () => {
    const { container, getByTestId } = render(<Host />)
    const host = getByTestId("host")
    moveTo(host, WIDTH)
    const atEdge = tiltOf(container)
    moveTo(host, WIDTH * 5) // far outside
    expect(tiltOf(container)).toBe(atEdge)
  })

  it("returns to level on leave, so the next reveal starts straight", () => {
    const { container, getByTestId } = render(<Host />)
    const host = getByTestId("host")
    moveTo(host, 0)
    expect(tiltOf(container)).not.toBe("translateX(0.0px) rotate(0.0deg)")
    fireEvent.mouseLeave(host)
    expect(tiltOf(container)).toBe("translateX(0.0px) rotate(0.0deg)")
  })

  it("keeps reveal and tilt on separate elements", () => {
    // Sharing one element would make every mouse move restart the entry
    // bounce, which is why the component nests them.
    const { container } = render(<Host />)
    expect(container.querySelector(".tip").style.transform).toBe("")
    expect(container.querySelector(".tip-inner").style.transform).toContain("rotate")
  })

  it("honours the placement", () => {
    const { container } = render(<Host placement="bottom" />)
    expect(container.querySelector(".tip").className).toContain("tip-bottom")
  })
})
