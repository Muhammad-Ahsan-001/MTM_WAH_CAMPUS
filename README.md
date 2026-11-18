# MTM_WAH_CAMPUS

Project workspace. Services are wired up; no application code yet.

| Service  | Linked to |
|----------|-----------|
| GitHub   | [Muhammad-Ahsan-001/MTM_WAH_CAMPUS](https://github.com/Muhammad-Ahsan-001/MTM_WAH_CAMPUS) (private) |
| Supabase | [MTM_WAH_CAMPUS](https://supabase.com/dashboard/project/emhbqdihgbkvnaifkuno) · ref `emhbqdihgbkvnaifkuno` · org REGIS · ap-south-1 (Mumbai) |
| Vercel   | [mtm-wah-campus](https://vercel.com/mahsan7861100-9210s-projects/mtm-wah-campus) · deploys from `main` |

## Local setup

- `.env.local` (gitignored) holds the Supabase URL and public keys. `.env.example` lists the variable names.
- `supabase/config.toml` is the Supabase CLI config; this folder is linked to the remote project.
- `vercel env pull` overwrites `.env.local`, so add the Supabase variables to Vercel first
  (or install the Supabase integration in Vercel) before pulling.
