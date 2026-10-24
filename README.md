# Punchlist (v2: accounts + cloud sync)
A mobile-first PWA built with plain HTML, CSS and JS, with no build step. Data lives in Supabase (project `vuufeeoalufcxzuoitbs`) with row-level security on every table. Photo-transcription keys stay on the phone.

## Accounts
- There are two roles. **Admin** sees and manages everything. **Vendor** sees only items assigned to them, plus items they are cc'd on (read-only), and can check off only their own items.
- An admin creates a person in **Team** and gets a one-time invite code (XXXX-XXXX, valid 30 days). The person taps **Create account**, enters an email, a password and the code, confirms their email, and signs in. The code links their login to the profile.
- When an item is checked off, everyone cc'd on it gets a notification (bell + badge, live via Realtime). Admins are notified when a vendor completes an item. Vendors are notified when they are assigned or cc'd on an item.
- On an admin's first sign-in, any old v1 data on that phone can be uploaded (it can also be done later from Settings).

## Files
- `js/config.js`: the Supabase URL and the **publishable** key only. Never put the service_role key in this app.
- `supabase/migrations/`: the schema, policies, RPCs and triggers (already applied).
- `supabase/tests/rls_test.sql`: an RLS test that impersonates the roles. Run it in the SQL editor. It raises its results, so everything rolls back.
- `js/parse.js` and `js/transcribe.js`: header parsing, fuzzy matching and photo transcription (unchanged from v1).

## Dev
- Run locally: `python3 -m http.server 8080`, then open http://127.0.0.1:8080/
- Unit tests: `node --test tests/`
- UI test: `node tests/e2e-v2.js`. It needs temporary test logins in the project (see the script) plus playwright-core and Chrome, and writes screenshots/.
- Deploy: GitHub Pages via `.github/workflows/pages.yml`. Bump `VERSION` in `sw.js` on every release.
