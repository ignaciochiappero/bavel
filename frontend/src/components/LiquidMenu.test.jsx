import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import LiquidMenu from "./LiquidMenu"

afterEach(cleanup)

const items = [
  { key: "a", label: "Uno", icon: <i data-testid="i-a" />, onClick: vi.fn() },
  { key: "b", label: "Dos", icon: <i data-testid="i-b" />, onClick: vi.fn() },
  { key: "c", label: "Tres", icon: <i data-testid="i-c" />, onClick: vi.fn(), disabled: true },
]

const open = () => fireEvent.click(screen.getByRole("button", { name: "Acciones" }))

describe("LiquidMenu", () => {
  it("starts collapsed with only the trigger reachable", () => {
    render(<LiquidMenu items={items} />)
    expect(screen.getByRole("button", { name: "Acciones" })).toBeTruthy()
    // Collapsed items are aria-hidden, so they must not surface by role.
    expect(screen.queryByRole("button", { name: "Uno" })).toBeNull()
  })

  it("exposes the actions once opened", () => {
    render(<LiquidMenu items={items} />)
    open()
    expect(screen.getByRole("button", { name: "Uno" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Dos" })).toBeTruthy()
  })

  it("keeps collapsed items out of the tab order", () => {
    const { container } = render(<LiquidMenu items={items} />)
    const collapsed = container.querySelectorAll(
      ".liquid-item:not(.liquid-trigger)",
    )
    collapsed.forEach((el) => expect(el.getAttribute("tabindex")).toBe("-1"))
    open()
    container
      .querySelectorAll(".liquid-item:not(.liquid-trigger)")
      .forEach((el) => expect(el.getAttribute("tabindex")).toBe("0"))
  })

  it("runs the action and closes", () => {
    render(<LiquidMenu items={items} />)
    open()
    fireEvent.click(screen.getByRole("button", { name: "Dos" }))
    expect(items[1].onClick).toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Dos" })).toBeNull()
  })

  it("honours a disabled action", () => {
    render(<LiquidMenu items={items} />)
    open()
    const btn = screen.getByRole("button", { name: "Tres" })
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(items[2].onClick).not.toHaveBeenCalled()
  })

  it("closes on Escape", () => {
    render(<LiquidMenu items={items} />)
    open()
    expect(screen.getByRole("button", { name: "Uno" })).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("button", { name: "Uno" })).toBeNull()
  })

  it("closes when clicking away", () => {
    render(
      <div>
        <LiquidMenu items={items} />
        <button>fuera</button>
      </div>,
    )
    open()
    fireEvent.mouseDown(screen.getByRole("button", { name: "fuera" }))
    expect(screen.queryByRole("button", { name: "Uno" })).toBeNull()
  })

  it("stacks the actions on the trigger when closed", () => {
    const { container } = render(<LiquidMenu items={items} />)
    const closed = [...container.querySelectorAll(".liquid-item")]
      .filter((el) => !el.classList.contains("liquid-trigger"))
      .map((el) => el.style.transform)
    // All at the same spot, so the collapsed menu reads as a single button.
    expect(new Set(closed).size).toBe(1)

    open()
    const opened = [...container.querySelectorAll(".liquid-item")]
      .filter((el) => !el.classList.contains("liquid-trigger"))
      .map((el) => el.style.transform)
    expect(new Set(opened).size).toBe(items.length)
  })

  it("gives every action a glass surface, not a filtered halo", () => {
    // The gooey blob layer is gone on purpose: translucent merging shapes
    // render as a smear of light instead of liquid.
    const { container } = render(<LiquidMenu items={items} />)
    expect(container.querySelector(".liquid-blobs")).toBeNull()
    expect(container.querySelector(".liquid-blobs-goo")).toBeNull()
    expect(container.querySelector(".liquid-items").style.filter).toBe("")
  })

  it("fans the items out on an arc, not down a line", () => {
    // A vertical stack pulls neighbours apart; the arc keeps them within
    // reach of each other so the necks can form.
    const { container } = render(<LiquidMenu items={items} />)
    open()
    const transforms = [...container.querySelectorAll(".liquid-item")]
      .filter((el) => !el.classList.contains("liquid-trigger"))
      .map((el) => el.style.transform)
    const xs = transforms.map((t) => parseFloat(t.match(/translate\(([-\d.]+)px/)[1]))
    // Items must differ horizontally — otherwise it is a column.
    expect(new Set(xs).size).toBeGreaterThan(1)
  })

  it("staggers the items so the group unpeels", () => {
    const { container } = render(<LiquidMenu items={items} />)
    open()
    const delays = [...container.querySelectorAll(".liquid-item")]
      .filter((el) => !el.classList.contains("liquid-trigger"))
      .map((el) => el.style.transitionDelay)
    expect(new Set(delays).size).toBe(items.length)
  })
})

describe("LiquidMenu tooltips", () => {
  it("labels every action with a tooltip", () => {
    const { container } = render(<LiquidMenu items={items} />)
    open()
    const tips = [...container.querySelectorAll(".tip")].map((t) => t.textContent)
    expect(tips).toEqual(expect.arrayContaining(["Uno", "Dos", "Tres"]))
  })

  it("does not set a native title, which would double up on the tooltip", () => {
    const { container } = render(<LiquidMenu items={items} />)
    open()
    container
      .querySelectorAll(".liquid-item")
      .forEach((el) => expect(el.getAttribute("title")).toBeNull())
  })

  it("keeps the accessible name on the button, not only in the tooltip", () => {
    render(<LiquidMenu items={items} />)
    open()
    // The tooltip is decoration; screen readers must still get the label.
    expect(screen.getByRole("button", { name: "Uno" })).toBeTruthy()
  })
})
