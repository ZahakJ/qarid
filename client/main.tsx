import { StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"

// Phase-0 placeholder shell. Later agents replace <Placeholder/> with <App/>
// (router + views); the appReady contract below must survive that swap —
// tools/screenshot.mjs waits on body[data-app-ready="1"].
function Placeholder() {
  useEffect(() => {
    document.body.dataset.appReady = "1"
  }, [])
  return (
    <main>
      <h1>قريض</h1>
      <p>ديوان الشعر العربي ومساجلته</p>
    </main>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
)
