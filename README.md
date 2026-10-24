# Punchlist (v3: vendor teams)
A mobile-first PWA built with plain HTML, CSS and JS, with no build step. Data lives in Supabase (project `vuufeeoalufcxzuoitbs`) with row-level security on every table. Photo-transcription keys stay on the phone.

## Accounts
- There are two roles. **Admin** sees and manages everything. **Vendor employee** belongs to one vendor (a company or crew, e.g. *D2*). They see all of that vendor's items and can check any of them off, and they can see items their vendor is cc'd on (read-only). They never see another vendor's items.
- In **Team**, an admin adds a vendor (e.g. D2), then adds its employees (e.g. Leo). Each employee gets a one-time invite code (XXXX-XXXX, valid 30 days). They tap **Create account**, enter their own email, password and code, confirm their email, and sign in. The code links their login to that employee profile.
- Items are assigned to a vendor (the whole team) and can be narrowed to one employee. The narrowing is a label and a notification target; every employee of that vendor can still see and check off the item. The app shows who actually completed each item.
- cc goes to a vendor, and every employee of a cc'd vendor is notified when the item is checked off. Admins are notified when an employee completes an item. Employees are notified when work is assigned to their team (or to them) or their team is cc'd.
- On an admin's first sign-in, any old v1 data on that phone can be uploaded (it can also be done later from Settings).

## Files
- `js/config.js`: the Supabase URL and the **publishable** key only. Never put the service_role key in this app.
- `supabase/migrations/`: the schema, policies, RPCs and triggers, all already applied. `20261024180000_vendor_teams.sql` adds vendors and employees.
- `supabase/tests/rls_test.sql`: an RLS test that impersonates the roles. Run it in the SQL editor. It raises its results, so everything rolls back.
- `js/parse.js` and `js/transcribe.js`: header parsing, fuzzy matching and photo transcription (unchanged from v1).

## Dev
- Run locally: `python3 -m http.server 8080`, then open http://127.0.0.1:8080/
- Unit tests: `node --test tests/`
- UI test: run `tests/e2e-v3-seed.sql`, then `node tests/e2e-v3.js` (needs playwright-core and Chrome; writes screenshots/30-38), then `tests/e2e-v3-cleanup.sql`. The test logins use @example.invalid addresses.
- Deploy: GitHub Pages via `.github/workflows/pages.yml`. Bump `VERSION` in `sw.js` on every release.
