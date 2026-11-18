# mtm_wah_campus

Frontend: React + Vite (JS/TS). Backend: Supabase. Hosting: Vercel.
Services are wired up; no application code yet.

| Service  | Linked to |
|----------|-----------|
| GitHub   | [Muhammad-Ahsan-001/MTM_WAH_CAMPUS](https://github.com/Muhammad-Ahsan-001/MTM_WAH_CAMPUS) (private) |
| Supabase | [MTM_WAH_CAMPUS](https://supabase.com/dashboard/project/emhbqdihgbkvnaifkuno) · ref `emhbqdihgbkvnaifkuno` · org REGIS · ap-south-1 (Mumbai) |
| Vercel   | [mtm-wah-campus](https://vercel.com/mahsan7861100-9210s-projects/mtm-wah-campus) · preset Vite · deploys from `main` · functions `bom1` (Mumbai) · Node 24.x |

## Environment variables

Stored on Vercel (Production, Preview, Development) and pulled locally with `vercel env pull .env.local`:

| Variable | Notes |
|----------|-------|
| `VITE_SUPABASE_URL` | Public |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Public, browser-safe (`sb_publishable_...`) |

The Supabase secret key never goes in a `VITE_` variable. Vite inlines those into the browser bundle.

## Scaffolding the app (do this in the repo root)

```bash
npx create-vite@latest . --template react-ts
```

When asked about the non-empty folder, pick **Ignore files and continue**. Do **not** pick
"Remove existing files": it deletes `.env.local`, `.vercel/` and the Supabase link.
Then restore this repo's `.gitignore` and `README.md` (Vite overwrites both):

```bash
git checkout -- .gitignore README.md
```

Use `--template react` instead for plain JavaScript.

## Config already in place

- `vercel.json`: Vite preset + SPA rewrite, so client-side routes don't 404 on refresh.
- `supabase/config.toml`: local Supabase stack, linked to the remote project. Local auth redirects use Vite's port 5173.

## When you add auth

Set Supabase Dashboard > Authentication > URL Configuration:

- Site URL: `https://mtm-wah-campus.vercel.app`
- Redirect URLs: `http://localhost:5173/**`, `https://mtm-wah-campus-*-mahsan7861100-9210s-projects.vercel.app/**`
