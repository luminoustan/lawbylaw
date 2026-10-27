/**
 * index.tsx — web entry point. Installs the in-page host (chat storage and the
 * agent loop) and mounts the chat UI.
 */

import { render } from "solid-js/web"
import "./styles.css"
import { SessionProvider } from "./store/session"
import { App } from "./App"
import { installWebHost } from "./host/web-host"
import { applyTheme } from "./lib/theme"

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")

applyTheme()
installWebHost()

render(
  () => (
    <SessionProvider>
      <App />
    </SessionProvider>
  ),
  root,
)
