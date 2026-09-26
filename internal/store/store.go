package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

type Monitor struct {
	ID        string
	Name      string
	URL       string
	Interval  int
	Timeout   int
	Enabled   bool
	UpdatedAt time.Time
}

func (s *Store) GetActiveMonitors(ctx context.Context) ([]Monitor, error) {
	monitors := []Monitor{}
	rows, err := s.pool.Query(ctx, "SELECT id, name, url, interval_s, timeout_s, enabled, updated_at FROM monitors WHERE enabled = true")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		curr := Monitor{}
		err := rows.Scan(&curr.ID, &curr.Name, &curr.URL, &curr.Interval, &curr.Timeout, &curr.Enabled, &curr.UpdatedAt)
		if err != nil {
			continue
		}
		monitors = append(monitors, curr)
	}

	return monitors, rows.Err()
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
