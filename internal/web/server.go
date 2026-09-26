package web

import (
	"net/http"

	"github.com/antonov-denis/ping/internal/store"
)

type Server struct {
	s   *store.Store
	mux *http.ServeMux
}

func (s *Server) routes() {
	s.mux = http.NewServeMux()

	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("GET /api/status", s.handleStatus)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func NewServer(s *store.Store) *Server {
	server := Server{s: s}
	server.routes()

	return &server
}
