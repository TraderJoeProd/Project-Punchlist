# Punchlist

Static progressive web app for construction punch lists, grouped by company and job address. Photograph a handwritten list and transcribe it in the browser with Tesseract, or with an OpenAI or Gemini key that stays in this device's storage.

Add companies and addresses, then build a list or tap Scan. Everything is saved in localStorage. Settings can export or import a JSON backup, and a list can be shared or printed.

No build step. The site is the repository root (`index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`, `sw.js`). Asset paths, the manifest `start_url`/`scope`, and the service worker are relative so the app works from a project-site subpath.

Live site: https://traderjoeprod.github.io/Project-Punchlist/

GitHub Pages deploys that root on every push to `main` (`.github/workflows/pages.yml`).
