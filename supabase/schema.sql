-- Anaga / Modcon Builders — Supabase schema
-- Run this in Supabase SQL Editor (Project → SQL Editor → New query).
-- Idempotent: uses IF NOT EXISTS / IF NOT EXISTS checks throughout.

-- ============================================================
-- 1. LEADS TABLE (already exists from initial setup)
--    Add client_id column for multi-tenant isolation.
-- ============================================================
create table if not exists public.leads (
  id           bigint generated always as identity primary key,
  created_at   timestamptz default now() not null,
  ts           text,
  name         text,
  phone        text,
  language     text,
  "callType"   text,
  disposition  text,
  score        text,
  interested   text,
  summary      text,
  "nextAction" text,
  comment      text,
  "bookingDay" text,
  "callId"     text,
  source       text,
  recording    text,
  client_id    text default 'modcon'
);

-- Add client_id to existing table if upgrading
alter table public.leads add column if not exists client_id text default 'modcon';

-- Index for dashboard queries
create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_client_id_idx  on public.leads (client_id);
create index if not exists leads_disposition_idx on public.leads (disposition);

-- RLS: service-role key bypasses RLS (backend writes). Public reads blocked.
alter table public.leads enable row level security;
-- No policies = only service-role can read/write (correct for our use case).

-- ============================================================
-- 2. CLIENTS TABLE (B2B tenants / builder-clients)
-- ============================================================
create table if not exists public.clients (
  id          text primary key,                -- e.g. 'modcon', 'builder2'
  name        text not null,
  config      jsonb,                           -- full client config (keys managed separately)
  api_key     text unique,                     -- optional per-client API key
  active      boolean default true,
  created_at  timestamptz default now() not null
);

alter table public.clients enable row level security;
-- No policies = service-role only.

-- Seed the default Modcon tenant
insert into public.clients (id, name, active)
values ('modcon', 'Modcon Builders', true)
on conflict (id) do nothing;

-- ============================================================
-- 3. BOOKINGS TABLE (site-visit calendar bookings)
-- ============================================================
create table if not exists public.bookings (
  id               bigint generated always as identity primary key,
  created_at       timestamptz default now() not null,
  client_id        text default 'modcon',
  lead_name        text,
  lead_phone       text,
  slot_time        timestamptz,
  slot_label       text,
  calendar_event_id text,
  calendar_link    text,
  language         text,
  direction        text default 'outbound',
  notes            text,
  status           text default 'confirmed'  -- confirmed | cancelled | rescheduled
);

create index if not exists bookings_client_id_idx on public.bookings (client_id);
create index if not exists bookings_slot_time_idx on public.bookings (slot_time);
create index if not exists bookings_lead_phone_idx on public.bookings (lead_phone);

alter table public.bookings enable row level security;

-- ============================================================
-- 4. FOLLOWUP_QUEUE TABLE (multi-touch nurture sequences)
-- ============================================================
create table if not exists public.followup_queue (
  id            bigint generated always as identity primary key,
  created_at    timestamptz default now() not null,
  client_id     text default 'modcon',
  lead_phone    text not null,
  lead_name     text,
  sequence_day  int not null,             -- 1, 3, or 7
  language      text,
  disposition   text,
  summary       text,
  send_at       timestamptz not null,
  sent_at       timestamptz,
  status        text default 'pending'    -- pending | sent | failed | skipped
);

create index if not exists fq_status_send_at_idx on public.followup_queue (status, send_at);
create index if not exists fq_client_id_idx on public.followup_queue (client_id);
create index if not exists fq_lead_phone_idx on public.followup_queue (lead_phone);

alter table public.followup_queue enable row level security;

-- ============================================================
-- 5b. KNOWLEDGE BASE (RAG — Gemini embeddings + pgvector)
--     The blueprint's "Pinecone" tier, free on Supabase.
-- ============================================================
create extension if not exists vector;

create table if not exists public.knowledge_base (
  id          bigint generated always as identity primary key,
  created_at  timestamptz default now() not null,
  client_id   text default 'modcon' not null,
  title       text,
  content     text not null,
  source      text,
  embedding   vector(768),               -- Gemini text-embedding-004
  metadata    jsonb
);

create index if not exists kb_client_id_idx on public.knowledge_base (client_id);
create index if not exists kb_embedding_idx on public.knowledge_base
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.knowledge_base enable row level security;

create or replace function public.match_knowledge(
  query_embedding vector(768),
  match_client_id text,
  match_count int default 5,
  min_similarity float default 0.25
) returns table (id bigint, title text, content text, similarity float)
language sql stable as $$
  select kb.id, kb.title, kb.content,
         1 - (kb.embedding <=> query_embedding) as similarity
  from public.knowledge_base kb
  where kb.client_id = match_client_id
    and kb.embedding is not null
    and 1 - (kb.embedding <=> query_embedding) > min_similarity
  order by kb.embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================
-- 5. CAMPAIGNS TABLE (track outbound campaign batches)
-- ============================================================
create table if not exists public.campaigns (
  id          bigint generated always as identity primary key,
  created_at  timestamptz default now() not null,
  client_id   text default 'modcon',
  name        text,
  direction   text default 'outbound',
  total       int default 0,
  queued      int default 0,
  failed      int default 0,
  skipped     int default 0,
  status      text default 'dispatched'
);

alter table public.campaigns enable row level security;
