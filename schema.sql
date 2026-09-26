create table monitors (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null unique,
  url         text        not null,
  interval_s  int         not null default 60,
  timeout_s   int         not null default 10,
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  disabled_at timestamptz
);

create table results (
  id          uuid        primary key default gen_random_uuid(),
  monitor_id  uuid        not null references monitors(id) on delete cascade,
  url         text        not null,
  checked_at  timestamptz not null,   -- when the probe ran (prober's clock)
  ok          boolean     not null,
  status_code int,                    -- null when no response was received
  latency_ms  int         not null,
  error       text,                   -- null when ok
  created_at  timestamptz not null default now()  -- when the row was written
);

create index results_monitor_id_checked_at_idx on results (monitor_id, checked_at desc);
