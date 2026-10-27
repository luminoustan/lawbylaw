/** theme.ts — dark/light theme, remembered in localStorage, default from the OS. */

export type ThemeMode = "dark" | "light"
const KEY = "lbl-theme"

export function currentTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === "dark" || v === "light") return v
  } catch {
    /* storage blocked */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"
}

export function applyTheme(mode: ThemeMode = currentTheme()): void {
  document.documentElement.classList.toggle("theme-light", mode === "light")
}

export function setTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* storage blocked */
  }
  applyTheme(mode)
}
