package web

import (
	"cmp"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"time"

	"github.com/antonov-denis/ping/internal/store"
)

const bucketCount = 180

var windowDurations = map[string]time.Duration{
	"1h": time.Hour, "3h": 3 * time.Hour, "12h": 12 * time.Hour,
	"1d": 24 * time.Hour, "3d": 72 * time.Hour, "7d": 168 * time.Hour,
}

type StatusResponse struct {
	Name    string
	URL     string
	Up      bool
	Uptime  float64
	AvgMS   int
	From    time.Time       // start of the window
	To      time.Time       // end of the window
	Buckets []*store.Bucket // oldest first; gaps are absent, place them by Start
}

// summarise fills Uptime and AvgMS from the buckets collected.
func (sr *StatusResponse) summarise() {
	var total, okCount, latency int
	for _, b := range sr.Buckets {
		total += b.Total
		okCount += b.OKCount
		latency += b.AvgMS * b.Total
	}
	if total == 0 {
		return
	}
	sr.Uptime = float64(okCount) * 100 / float64(total)
	sr.AvgMS = latency / total
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("OK!"))
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	window, ok := windowDurations[r.URL.Query().Get("window")]
	if !ok {
		http.Error(w, "Invalid window!", http.StatusBadRequest)
		return
	}
	bucketSecs := int64(window.Seconds()) / bucketCount

	monitors, err := s.s.GetMonitors(r.Context())
	if err != nil {
		slog.Error("Couldn't get monitors", "err", err)
		http.Error(w, "Something went wrong!", http.StatusInternalServerError)
		return
	}
	buckets, err := s.s.GetResultBuckets(r.Context(), window, int(bucketSecs))
	if err != nil {
		slog.Error("Couldn't get buckets", "err", err)
		http.Error(w, "Something went wrong!", http.StatusInternalServerError)
		return
	}
	latest, err := s.s.GetLatestResults(r.Context())
	if err != nil {
		slog.Error("Couldn't get last results", "err", err)
		http.Error(w, "Something went wrong!", http.StatusInternalServerError)
		return
	}

	byID := map[string]*StatusResponse{}

	for _, m := range monitors {
		byID[m.ID] = &StatusResponse{Name: m.Name, URL: m.URL, Buckets: []*store.Bucket{}}
	}

	for _, b := range buckets {
		if m, ok := byID[b.MonitorID]; ok {
			m.Buckets = append(m.Buckets, &b)
		}
	}

	for _, lr := range latest {
		if m, ok := byID[lr.MonitorID]; ok {
			m.Up = lr.OK
		}
	}

	from, to := time.Now().Add(-window), time.Now()
	out := make([]*StatusResponse, 0, len(byID))
	for _, m := range byID {
		m.From, m.To = from, to
		m.summarise()
		out = append(out, m)
	}
	slices.SortFunc(out, func(a, b *StatusResponse) int { return cmp.Compare(a.Name, b.Name) })

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(out); err != nil {
		slog.Error("Couldn't encode status", "err", err)
	}
}
