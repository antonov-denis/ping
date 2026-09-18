package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/antonov-denis/ping/internal/event"
	"github.com/antonov-denis/ping/internal/store"
	"github.com/joho/godotenv"
)

func probe(pctx context.Context, m store.Monitor) event.ProbeResult {
	e := event.ProbeResult{
		Monitor:   m.Name,
		URL:       m.URL,
		OK:        false,
		CheckedAt: time.Now().UTC(),
	}

	ctx, cancel := context.WithTimeout(pctx, time.Duration(m.Timeout)*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.URL, nil)
	if err != nil {
		e.Error = err.Error()
		return e
	}

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.LatencyMS = int(time.Since(start).Milliseconds())
		e.Error = err.Error()
		return e
	}

	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		e.OK = true
	}

	e.StatusCode = resp.StatusCode
	e.LatencyMS = int(time.Since(start).Milliseconds())
	return e
}

func runProbe(ctx context.Context, m store.Monitor, ec *event.Client) {
	t := time.NewTicker(time.Duration(m.Interval) * time.Second)
	defer t.Stop()

	for {
		res := probe(ctx, m)
		if ctx.Err() != nil {
			return
		}

		err := ec.PublishProbe(ctx, res)
		if err != nil {
			slog.Error("Couldn't publish probe result", "err", err)
		}

		select {
		case <-t.C:
		case <-ctx.Done():
			return
		}
	}
}

func main() {
	_ = godotenv.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s, err := store.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		slog.Error("Cloudn't create store", "err", err)
		os.Exit(1)
	}
	defer s.Close()

	ec, err := event.NewClient(os.Getenv("KAFKA_URL"))
	if err != nil {
		slog.Error("Cloudn't create Kafka client", "err", err)
		os.Exit(1)
	}
	defer ec.Close()

	monitors, err := s.GetMonitors(ctx)
	if err != nil {
		slog.Error("Couldn't get monitors", "err", err)
		os.Exit(1)
	}

	wg := sync.WaitGroup{}
	for _, monitor := range monitors {
		wg.Go(func() {
			runProbe(ctx, monitor, ec)
		})
	}

	wg.Wait()
	slog.Info("Shutting down")
}
