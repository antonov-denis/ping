package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/antonov-denis/ping/internal/store"
	"github.com/antonov-denis/ping/internal/web"
	"github.com/joho/godotenv"
)

func run() error {
	_ = godotenv.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s, err := store.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		slog.Error("Cloudn't create store", "err", err)
		return err
	}
	defer s.Close()

	srv := web.NewServer(s)

	server := http.Server{
		Addr:         ":8000",
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  60 * time.Second,
		Handler:      srv,
	}

	shutdown := make(chan error, 1)
	go func() {
		<-ctx.Done()
		slog.Info("Shutting down")

		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		shutdown <- server.Shutdown(sctx)
	}()

	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}

	return <-shutdown
}

func main() {
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}
