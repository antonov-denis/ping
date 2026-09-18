package event

import (
	"encoding/json"
	"time"
)

const PingResultsTopic = "ping.results"

type Result struct {
	Monitor    string    `json:"monitor"`
	URL        string    `json:"url"`
	OK         bool      `json:"ok"`
	StatusCode int       `json:"status_code,omitempty"`
	CheckedAt  time.Time `json:"checked_at"`
	LatencyMS  int       `json:"latency_ms"`
	Error      string    `json:"error,omitempty"`
}

func (r Result) Marshal() ([]byte, error) { return json.Marshal(r) }

func Unmarshal(b []byte) (Result, error) {
	var r Result
	err := json.Unmarshal(b, &r)
	return r, err
}
