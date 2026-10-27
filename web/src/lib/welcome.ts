/**
 * welcome.ts: has this browser seen the first-visit notice?
 *
 * The flag lives in localStorage under a versioned name, so changing the notice's meaning (bump the
 * version) shows it again to everyone. If the browser blocks storage the flag is held in memory, so
 * the notice is shown once per page load instead of on every render.
 */

export const WELCOME_ENTRY = "lawbylaw.welcome.v3"

let seenInMemory = false

export function welcomeSeen(): boolean {
  if (seenInMemory) return true
  try {
    return localStorage.getItem(WELCOME_ENTRY) !== null
  } catch {
    return false
  }
}

export function markWelcomeSeen(): void {
  seenInMemory = true
  try {
    localStorage.setItem(WELCOME_ENTRY, new Date().toISOString())
  } catch {
    /* blocked: the in-memory flag still covers this page load */
  }
}

/** For tests. */
export function resetWelcomeForTests(): void {
  seenInMemory = false
}

/** The points shown, in order. Kept as data so the wording is reviewed in one place and tested. */
export const WELCOME_POINTS: readonly string[] = [
  "This app is a submission to the Nebius x NVIDIA Global AI Hackathon.",
  "It is served from a homelab physically located in Singapore. Embeddings and reranking are done with a single Nvidia RTX 3060.",
  "Singapore legislation is subject to copyright of the Singapore Government and is used/reproduced for the purposes of the relevant material/platform with the permission of the Attorney-General's Chambers (AGC).",
  "Users of the relevant material/platform may check Singapore Statutes Online (SSO) for the latest version of Singapore legislation.",
  "The app will be taken down after the judging period, December 2 to December 16, 2026.",
  "Your questions are sent to Nebius Token Factory with the free key, or to Nebius or DeepSeek with your own key, to generate the answer. The providers' retention and training terms apply. Do not paste sensitive personal information.",
]
