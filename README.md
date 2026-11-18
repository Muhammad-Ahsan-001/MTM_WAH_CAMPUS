# MTM_WAH_CAMPUS

Project workspace. Services are wired up; no application code yet.

| Service  | Linked to |
|----------|-----------|
| GitHub   | [Muhammad-Ahsan-001/MTM_WAH_CAMPUS](https://github.com/Muhammad-Ahsan-001/MTM_WAH_CAMPUS) (private) |
| Supabase | [MTM_WAH_CAMPUS](https://supabase.com/dashboard/project/emhbqdihgbkvnaifkuno) · ref `emhbqdihgbkvnaifkuno` · org REGIS · ap-south-1 (Mumbai) |
| Vercel   | [mtm-wah-campus](https://vercel.com/mahsan7861100-9210s-projects/mtm-wah-campus) · deploys from `main` · functions in `bom1` (Mumbai) · Node 24.x |

## Local setup

- `.env.local` (gitignored) holds the Supabase URL and public keys. `.env.example` lists the variable names.
- `supabase/config.toml` is the Supabase CLI config; this folder is linked to the remote project.
- `vercel env pull` rewrites `.env.local`. Add the Supabase variables to Vercel first
  (or install the Supabase integration in Vercel) so a pull keeps them.

## Before the first app push

- The Vercel Framework Preset is unset ("Other"). Set it to the framework you pick
  (Project Settings > Build and Deployment), or the first build will not use it.
- Add the Supabase variables to Vercel, with your framework's browser prefix
  (`NEXT_PUBLIC_` / `VITE_`). Keep the secret key server-only.
- `npx create-next-app .` refuses this folder (uppercase name, existing files), and
  `npm create vite . --overwrite` deletes `.env.local`, `.vercel/` and the Supabase link.
  Scaffold into a lowercase temp folder and move the files in, merging `.gitignore` and `README.md`.
