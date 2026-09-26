package event

import (
	"context"
	"encoding/json"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

const ProbeResultsTopic = "probe.results"

type ProbeResult struct {
	MonitorID  string    `json:"monitor_id"`
	Monitor    string    `json:"monitor"`
	URL        string    `json:"url"`
	OK         bool      `json:"ok"`
	StatusCode int       `json:"status_code,omitempty"`
	CheckedAt  time.Time `json:"checked_at"`
	LatencyMS  int       `json:"latency_ms"`
	Error      string    `json:"error,omitempty"`
}

func (r ProbeResult) Marshal() ([]byte, error) { return json.Marshal(r) }

func Unmarshal(b []byte) (ProbeResult, error) {
	var r ProbeResult
	err := json.Unmarshal(b, &r)
	return r, err
}

type Producer struct {
	client *kgo.Client
}

func (c *Producer) Close() {
	c.client.Close()
}

func (c *Producer) PublishProbe(ctx context.Context, pr ProbeResult) error {
	v, err := pr.Marshal()
	if err != nil {
		return err
	}

	record := &kgo.Record{
		Topic: ProbeResultsTopic,
		Key:   []byte(pr.Monitor),
		Value: v,
	}

	return c.client.ProduceSync(ctx, record).FirstErr()
}

func NewProducer(kafkaURL string) (*Producer, error) {
	ec, err := kgo.NewClient(kgo.SeedBrokers(kafkaURL))
	if err != nil {
		return nil, err
	}

	return &Producer{client: ec}, nil
}
