package store

import (
	"context"
	"time"

	"github.com/antonov-denis/ping/internal/event"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

type Monitor struct {
	ID         string
	Name       string
	URL        string
	Interval   int
	Timeout    int
	Enabled    bool
	UpdatedAt  time.Time
	DisabledAt *time.Time
}

type Result struct {
	MonitorID string
	URL       string
	CheckedAt time.Time
	OK        bool
	LatencyMs int
}

type Bucket struct {
	MonitorID string
	Start     time.Time
	Total     int
	OKCount   int
	AvgMS     int
	MaxMS     int
}

func (s *Store) queryMonitors(ctx context.Context, sqlStr string) ([]Monitor, error) {
	monitors := []Monitor{}
	rows, err := s.pool.Query(ctx, sqlStr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		curr := Monitor{}
		err := rows.Scan(&curr.ID, &curr.Name, &curr.URL, &curr.Interval, &curr.Timeout, &curr.Enabled, &curr.UpdatedAt, &curr.DisabledAt)
		if err != nil {
			continue
		}
		monitors = append(monitors, curr)
	}

	return monitors, rows.Err()
}

func (s *Store) GetActiveMonitors(ctx context.Context) ([]Monitor, error) {
	return s.queryMonitors(ctx, "SELECT id, name, url, interval_s, timeout_s, enabled, updated_at, disabled_at FROM monitors WHERE enabled = true")
}

func (s *Store) GetMonitors(ctx context.Context) ([]Monitor, error) {
	return s.queryMonitors(ctx, "SELECT id, name, url, interval_s, timeout_s, enabled, updated_at, disabled_at FROM monitors")
}

func (s *Store) InsertResult(ctx context.Context, r event.ProbeResult) error {
	var sc *int
	if r.StatusCode != 0 {
		sc = &r.StatusCode
	}

	_, err := s.pool.Exec(
		ctx,
		`insert into results (monitor_id, url, checked_at, ok, status_code, latency_ms, error) values ($1, $2, $3, $4, $5, $6, $7)`,
		r.MonitorID, r.URL, r.CheckedAt, r.OK, sc, r.LatencyMS, r.Error,
	)

	return err
}

func (s *Store) GetResultBuckets(ctx context.Context, window time.Duration, bucketSize int) ([]Bucket, error) {
	buckets := []Bucket{}
	rows, err := s.pool.Query(
		ctx,
		`select
			monitor_id,
			to_timestamp(floor(extract(epoch from checked_at) / $2) * $2) as bucket,
			count(*)                   as total,
			count(*) filter (where ok) as ok_count,
			round(avg(latency_ms))     as avg_ms,
			max(latency_ms)            as max_ms
		from results
		where checked_at > now() - $1::interval
		group by monitor_id, bucket
		order by monitor_id, bucket`,
		window, bucketSize,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		curr := Bucket{}
		err := rows.Scan(&curr.MonitorID, &curr.Start, &curr.Total, &curr.OKCount, &curr.AvgMS, &curr.MaxMS)
		if err != nil {
			continue
		}
		buckets = append(buckets, curr)
	}

	return buckets, rows.Err()
}

func (s *Store) GetLatestResults(ctx context.Context) ([]Result, error) {
	res := []Result{}

	rows, err := s.pool.Query(
		ctx,
		`select distinct on (monitor_id)
  			monitor_id, checked_at, ok, latency_ms
		from results
		order by monitor_id, checked_at desc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		curr := Result{}
		err := rows.Scan(&curr.MonitorID, &curr.CheckedAt, &curr.OK, &curr.LatencyMs)
		if err != nil {
			continue
		}
		res = append(res, curr)
	}

	return res, rows.Err()
}

func (s *Store) Close() {
	s.pool.Close()
}

func New(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}

	return &Store{pool: pool}, nil
}
