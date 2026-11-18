-- SceneBnao: mirror of CLI/web sessions for the judging UI.
-- Writes go through the service role (CLI + server routes); anon may only SELECT.

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  label text not null default '',
  source text not null check (source in ('cli', 'web')),
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  batch int not null,
  seq int not null,
  raw text not null default '',
  sender text,
  role text,
  msg_date text,
  status text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (session_id, seq)
);

create table if not exists public.model_calls (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  batch int not null,
  seq int not null,
  model text not null,
  area text not null check (area in ('reading', 'venue', 'schedule', 'food', 'judging', 'budget')),
  input text not null,
  output text not null,
  prompt_tokens int,
  completion_tokens int,
  total_tokens int,
  cached_tokens int,
  reasoning_tokens int,
  latency_ms int not null,
  created_at timestamptz not null default now(),
  unique (session_id, seq)
);

create table if not exists public.decisions (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  batch int not null,
  kind text not null,
  message_seq int,
  area text,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists decisions_session_batch on public.decisions (session_id, batch);

create table if not exists public.plans (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  version int not null,
  plan jsonb not null,
  checks jsonb not null,
  areas_called text[] not null default '{}',
  areas_recomputed text[] not null default '{}',
  diff jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, version)
);

-- Row level security: anon/authenticated may read; only the service role (bypasses RLS) writes.
alter table public.sessions enable row level security;
alter table public.messages enable row level security;
alter table public.model_calls enable row level security;
alter table public.decisions enable row level security;
alter table public.plans enable row level security;

create policy "public read sessions" on public.sessions for select to anon, authenticated using (true);
create policy "public read messages" on public.messages for select to anon, authenticated using (true);
create policy "public read model_calls" on public.model_calls for select to anon, authenticated using (true);
create policy "public read decisions" on public.decisions for select to anon, authenticated using (true);
create policy "public read plans" on public.plans for select to anon, authenticated using (true);

-- Live updates in the UI.
alter publication supabase_realtime add table public.sessions, public.messages, public.model_calls, public.decisions, public.plans;
