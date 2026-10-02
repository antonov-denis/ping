# ping

A small, Pingdom-style uptime monitor written in Go.

## Purpose

`ping` checks a list of HTTP endpoints on a schedule, records whether each one
was up and how fast it answered, and shows the history on a dashboard.

It is deliberately small. It is a learning project for Go, Kubernetes and
Kafka (via Redpanda), and it is sized for about 100 monitors. Probing and
storage are split by a Kafka topic, so the producer (prober) and consumers
(writer, and later an alerter) are decoupled.

```
prober ──► [redpanda: probe.results] ──┬──► writer  ──► postgres
                                       └──► alerter ──► email   (not built yet)
                                  web  ◄── postgres  (JSON API + dashboard)
```

## Software

### Stack

| | |
|---|---|
| Language | Go `1.26.8` (`go.mod`), module `github.com/antonov-denis/ping` |
| Database | PostgreSQL 17, accessed with [`jackc/pgx/v5`](https://github.com/jackc/pgx) (`pgxpool`), hand-written SQL, no ORM |
| Messaging | Redpanda (Kafka API), accessed with [`twmb/franz-go`](https://github.com/twmb/franz-go) |
| Config | Environment variables, optionally loaded from `.env` by [`joho/godotenv`](https://github.com/joho/godotenv) |
| Frontend | One server-rendered HTML shell plus vanilla JS/CSS, embedded into the binary with `go:embed` |

### Binaries (`cmd/`)

| Binary | What it does |
|---|---|
| `cmd/prober` | Loads enabled monitors from Postgres and runs one goroutine per monitor on a ticker (`interval_s`). Each tick sends an HTTP `GET` with a `timeout_s` deadline. Any status from 200 to 399 counts as up. Each result is published to the `probe.results` topic, keyed by monitor name. Every 15 s it re-reads the monitors and starts new ones or stops removed or disabled ones. Edits to a running monitor (URL, interval, timeout) are **not** picked up. |
| `cmd/writer` | Kafka consumer in group `writer`. It inserts each `probe.results` record into the `results` table. |
| `cmd/web` | HTTP server on `:8000`. It serves the dashboard and JSON API, and shuts down cleanly on SIGINT/SIGTERM (10 s grace period). |

There is no alerter binary yet.

### Packages (`internal/`)

| Package | Responsibility |
|---|---|
| `internal/event` | The message format shared by all binaries: the `ProbeResult` struct (JSON), the `ProbeResultsTopic = "probe.results"` constant, and thin `Producer` / `Consumer` wrappers over franz-go. Records that fail to unmarshal are logged and skipped. |
| `internal/store` | `pgxpool`-backed `Store`: `GetActiveMonitors`, `GetMonitors`, `InsertResult`, `GetResultBuckets` (time-bucketed aggregates), `GetLatestResults` (latest result per monitor). |
| `internal/web` | `Server` (implements `http.Handler`) with routes, handlers, embedded `views/index.html` template and `static/` assets (JS, CSS, favicon, Geist fonts). |

### HTTP endpoints (`cmd/web`)

| Method & path | Response |
|---|---|
| `GET /` | Dashboard page |
| `GET /static/...` | Embedded static assets |
| `GET /health` | `OK!` (used by k8s probes) |
| `GET /api/status?window=<w>` | JSON array, one object per monitor, sorted by name |

`window` must be one of `1h`, `3h`, `12h`, `1d`, `3d`, `7d`. Any other value
returns `400`. The window is split into 180 buckets. Each monitor object has
the fields `Name`, `URL`, `Enabled`, `Up` (status of the latest result),
`Uptime` (%), `AvgMS`, `From`, `To` and `Buckets`. Each bucket has
`MonitorID`, `Start`, `Total`, `OKCount`, `AvgMS` and `MaxMS`. Buckets with no
data are left out of the array, so clients must position a bucket by `Start`
within `From`–`To`, not by its index.

The dashboard draws one timeline per monitor. It has window buttons (also
settable with `?window=`), a per-monitor detail dialog, a light/dark theme
toggle (saved in `localStorage`) and refreshes every 30 s.

### Configuration

All binaries read environment variables. A `.env` file in the working
directory is loaded if present. No command-line flags are defined.

| Variable | Used by | Example (local) |
|---|---|---|
| `DATABASE_URL` | prober, writer, web | `postgres://ping:ping@localhost:5432/ping` |
| `KAFKA_URL` | prober, writer | `localhost:19092` (host) / `redpanda:9092` (inside compose) |

The web listen address (`:8000`), the reconcile interval (15 s), the bucket
count (180) and the consumer group name (`writer`) are hard-coded.

### Database schema (`schema.sql`)

| Table | Columns | Notes |
|---|---|---|
| `monitors` | `id` uuid PK, `name` unique, `url`, `interval_s` (default 60), `timeout_s` (default 10), `enabled` (default true), `created_at`, `updated_at`, `disabled_at` | Monitors are soft-deleted: `enabled = false` and `disabled_at = now()`. |
| `results` | `id` uuid PK, `monitor_id` → `monitors(id)` `on delete cascade`, `url`, `checked_at` (prober clock), `ok`, `status_code` (null if there was no response), `latency_ms`, `error`, `created_at` | Index on `(monitor_id, checked_at desc)`. |

There is no migration tool. You apply `schema.sql` by hand.

### Running locally

`docker-compose.yaml` provides Postgres, Redpanda and Redpanda Console. The Go
binaries run on the host.

```bash
docker compose up -d
docker compose exec -T db psql -U ping -d ping < schema.sql
docker compose exec -T db psql -U ping -d ping < seed.sql        # optional demo data
docker compose exec redpanda rpk topic create probe.results -p 3 -r 1

set -a; source .env; set +a      # or rely on godotenv picking up .env
go run ./cmd/prober
go run ./cmd/writer
go run ./cmd/web                 # http://localhost:8000
```

You must create the `probe.results` topic yourself. franz-go does not request
auto-creation.

`seed.sql` is for development only. It **truncates** `monitors` (cascading to
`results`), then inserts six monitors (`google`, `denisantonov`, `badhost`,
`notfound`, `slowpoke`, and the disabled `retired`). It also backfills 7 days
of synthetic results: a daily latency curve, a few incidents, and a one-hour
prober outage that leaves a real gap. It uses a fixed random seed, so every run
produces the same data.

### Checks / tests

CI (`.github/workflows/ci.yml`, on push to `main` and on PRs) runs these checks:

```bash
gofmt -l .        # must be empty
go vet ./...
go build ./...
go test -race ./...
```

There are currently no `_test.go` files in the repository.

## Infrastructure

### Container image (`Dockerfile`)

| Stage | Base | What happens |
|---|---|---|
| `build` | `golang:1.26-alpine` | `go mod download`, then `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" ./cmd/...` |
| runtime | `gcr.io/distroless/static-debian12:nonroot` | Copies `/prober`, `/writer`, `/web`; runs as `nonroot:nonroot`; `EXPOSE 8000`; `ENTRYPOINT ["/web"]` |

All three binaries ship in one image. Kubernetes picks a binary per Deployment
by setting `command`. `.dockerignore` leaves out `.env`, `docker-compose.yaml`,
`.git`, `.github`, `k8s`, `CLAUDE.md`, `README.md` and `Makefile`.

### docker-compose services (local dev only)

| Service | Image | Host ports | Notes |
|---|---|---|---|
| `db` | `postgres:17` | `5432` | user/db `ping`, local-only password; volume `db_data` |
| `redpanda` | `redpandadata/redpanda:v24.2.7` | `19092` (Kafka, external listener), `9644` (admin/metrics) | internal listener `redpanda:9092`; volume `redpanda_data` |
| `console` | `redpandadata/console:v2.7.2` | `8080` | Redpanda Console UI, pointed at `redpanda:9092` |

### Kubernetes (`k8s/ping.yaml`)

The manifests target a single-node k3s cluster with Traefik and the
`local-path` storage class. Everything is in the `default` namespace. There
are no CronJobs or ConfigMaps.

| Kind | Name | Details |
|---|---|---|
| PersistentVolumeClaim | `ping-db` | 4Gi, `ReadWriteOnce`, `local-path` |
| Deployment | `ping-db` | `postgres:17`, 1 replica, `Recreate`; `POSTGRES_PASSWORD` from secret `ping-db`; `pg_isready` readiness probe; 128Mi request / 384Mi limit |
| Service | `ping-db` | port 5432 |
| PersistentVolumeClaim | `ping-redpanda` | 4Gi, `ReadWriteOnce`, `local-path` |
| Deployment | `ping-redpanda` | `redpandadata/redpanda:v25.2.5`, single node (`--smp=1 --memory=512M`), advertises `ping-redpanda:9092`; `rpk cluster health` readiness probe; 640Mi request / 1Gi limit |
| Service | `ping-redpanda` | ports 9092 (kafka), 33145 (rpc) |
| Deployment | `ping-prober` | image `ghcr.io/antonov-denis/ping:latest`, `command: ["/prober"]`, `Recreate`, `KAFKA_URL=ping-redpanda:9092`, `GOMEMLIMIT=100MiB`, 128Mi limit |
| Deployment | `ping-writer` | same image, `command: ["/writer"]`, `Recreate`, same env and limits |
| Deployment | `ping-web` | same image, `command: ["/web"]`, port 8000, liveness/readiness on `/health`, 128Mi / 100m CPU limit |
| Service | `ping-web` | port 80 → 8000 |
| Ingress | `ping-web` | host `ping.denisantonov.com`, Traefik TLS with the `letsencrypt` cert resolver |

The manifests reference these secrets but do not create them:

- `ping-db`, with keys `POSTGRES_PASSWORD` and `DATABASE_URL`. Create it by hand before applying the manifest.
- `ghcr-secret`, an image pull secret for GHCR.

The prober and writer each run as a single replica with the `Recreate`
strategy. This avoids duplicate probes and a second writer during a rollout.

### First-time setup on the cluster

The header comment of `k8s/ping.yaml` lists these steps, in this order:

1. Create the `ping-db` secret (`POSTGRES_PASSWORD`, `DATABASE_URL` pointing at `ping-db:5432/ping`).
2. `kubectl apply -f k8s/ping.yaml`. Wait until `ping-db` and `ping-redpanda` are ready.
3. Apply the schema: `kubectl exec -i deploy/ping-db -- psql -U ping -d ping < schema.sql`.
4. Create the topic: `kubectl exec deploy/ping-redpanda -- rpk topic create probe.results -p 3 -r 1`.
5. Insert the real monitors by hand. Do **not** run `seed.sql` in production, because it truncates the tables.
6. Point a DNS A record for `ping.denisantonov.com` at the server, so Traefik can complete the ACME challenge.

### Continuous deployment (`.github/workflows/deploy.yml`)

Every push to `main` triggers these steps:

1. Build the image and push it to `ghcr.io/antonov-denis/ping`, tagged `:<git sha>` and `:latest`.
2. SSH to the server (repository secrets `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY`).
3. Run `kubectl set image` on `ping-web`, `ping-writer` and `ping-prober` with the SHA tag.
4. Wait for `kubectl rollout status` on each Deployment.

The Postgres and Redpanda Deployments, the schema and the topic are not
managed by the pipeline.

## Known limitations

These are taken from the project notes and the code:

- The writer relies on franz-go auto-commit, so results can be lost if a Postgres insert fails.
- The prober ignores edits to a running monitor. Only add, remove and disable are detected.
- If a target returns a non-2xx/3xx status, the prober records `ok = false` and the status code, but leaves `error` empty.
- The alerter (email on consecutive failures) is not built.
