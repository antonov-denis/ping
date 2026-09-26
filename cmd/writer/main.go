package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/antonov-denis/ping/internal/event"
	"github.com/antonov-denis/ping/internal/store"
	"github.com/joho/godotenv"
)

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

	ec, err := event.NewConsumer(os.Getenv("KAFKA_URL"), "writer")
	if err != nil {
		slog.Error("Cloudn't create Kafka client", "err", err)
		os.Exit(1)
	}
	defer ec.Close()

	for {
		err = ec.Poll(
			ctx,
			func(pr event.ProbeResult) {
				err := s.InsertResult(ctx, pr)
				if err != nil {
					slog.Error("Couldn't insert record", "err", err)
				}
			},
		)
		if err != nil {
			slog.Error("Couldn't poll", "err", err)
		}
		if ctx.Err() != nil {
			break
		}
	}

	slog.Info("Shutting down")
}
