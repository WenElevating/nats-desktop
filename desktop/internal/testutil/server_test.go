package testutil

import (
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

func TestStartJSServerPubSub(t *testing.T) {
	url := StartJSServer(t)
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	got := make(chan []byte, 1)
	nc.Subscribe("smoke", func(m *nats.Msg) { got <- m.Data })
	nc.Publish("smoke", []byte("ok"))
	select {
	case d := <-got:
		if string(d) != "ok" {
			t.Fatal("bad payload")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no message")
	}
}
