import { describe, expect, it, vi } from "vitest"
import { render } from "solid-js/web"
import { STARTER_QUESTIONS, StarterQuestions } from "./StarterQuestions"

describe("StarterQuestions", () => {
  it("offers the three questions in order and sends the clicked one", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const onPick = vi.fn()
    const dispose = render(() => StarterQuestions({ onPick }), host)
    const buttons = [...host.querySelectorAll("button")]
    expect(buttons.map((b) => b.textContent)).toEqual([...STARTER_QUESTIONS])
    expect(STARTER_QUESTIONS).toEqual([
      "Tell me about the haze law in Singapore",
      "Is vape legal in Singapore?",
      "What does the Penal Code say about theft? Keep it very short.",
    ])
    buttons[1]!.click()
    expect(onPick).toHaveBeenCalledWith("Is vape legal in Singapore?")
    dispose()
    host.remove()
  })
})
