-- Project Details add-on: one row per Trello card, plus the history of
-- Move to LOST / KIV reasons. No one reads these tables directly: the
-- browser never gets a Supabase key. Only the "api" and "trello-webhook"
-- server functions (service role) read and write, after the Trello lock.

create table if not exists public.cards (
  card_id               text primary key,
  board_id              text not null,

  -- Above the tabs
  qualified             text check (qualified in ('yes', 'no')),
  why_not_qualified     text,
  priority              text check (priority in ('DEFCON 1', 'DEFCON 2', 'DEFCON 3')),
  chase_stage           text,
  chase_since           timestamptz,
  chase_log             jsonb not null default '[]'::jsonb,

  -- Requirement
  event_type            text,
  event_date            text,
  initial_budget        text,
  initial_pax           text,
  expected_close        text,
  probability           numeric,

  -- Expected Commercials
  projected_revenue     numeric,
  cogs                  numeric,
  margin                numeric generated always as (
                          case when projected_revenue is null or projected_revenue = 0 or cogs is null then null
                               else round(((projected_revenue - cogs) / projected_revenue) * 100, 1) end
                        ) stored,
  deposit               boolean not null default false,

  -- Customer Details
  first_name            text,
  last_name             text,
  email                 text,
  mobile                text,
  company_name          text,
  job_role              text,
  notes_on_customer     text,
  lead_source           text,
  initial_enquiry       text,
  lead_cycle_contacted  text,
  lead_cycle_proposed   text,

  -- Last Update (Auto): stamped on every save
  created_at            timestamptz not null default now(),
  last_update_at        timestamptz not null default now(),
  last_update_by        text,
  last_update_by_id     text
);

create index if not exists cards_board_idx on public.cards (board_id);

-- Every move into or out of LOST / KIV, with the reason.
create table if not exists public.card_moves (
  id                bigint generated always as identity primary key,
  card_id           text not null,
  board_id          text not null,
  from_list         text,
  to_list           text not null,
  why               text,
  needs_reason      boolean not null default false,
  source            text not null check (source in ('button', 'drag', 'back')),
  by_member_id      text,
  by_member_name    text,
  trello_action_id  text unique,
  comment_posted    boolean not null default false,
  at                timestamptz not null default now(),
  reason_at         timestamptz,
  reason_by         text
);

create index if not exists card_moves_card_idx on public.card_moves (card_id, at desc);
create index if not exists card_moves_board_idx on public.card_moves (board_id, at desc);

-- Last Update stamp: the database sets the time on every insert and update,
-- so the browser clock never decides it.
create or replace function public.stamp_last_update() returns trigger
language plpgsql as $$
begin
  new.last_update_at := now();
  return new;
end $$;

drop trigger if exists cards_stamp on public.cards;
create trigger cards_stamp before insert or update on public.cards
  for each row execute function public.stamp_last_update();

-- Lock the tables: row level security on, no policies, no grants to the
-- public roles. Only the service role (server functions) gets through.
alter table public.cards enable row level security;
alter table public.card_moves enable row level security;
revoke all on public.cards from anon, authenticated;
revoke all on public.card_moves from anon, authenticated;
