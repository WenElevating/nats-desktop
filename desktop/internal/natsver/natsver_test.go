package natsver

import "testing"

func TestServerAtLeast(t *testing.T) {
	cases := []struct {
		version string
		maj     int
		min     int
		pat     int
		want    bool
	}{
		{"2.15.0-preview.1", 2, 11, 0, true},
		{"2.11.0", 2, 11, 0, true},
		{"2.10.24", 2, 11, 0, false},
		{"2.11.0", 2, 11, 1, false},
		{"v2.9.1", 2, 10, 0, false},
		{"3.0.0", 2, 11, 0, true},
		{"v2.11.0", 2, 11, 0, true},
	}
	for _, c := range cases {
		got, err := ServerAtLeast(c.version, c.maj, c.min, c.pat)
		if err != nil {
			t.Fatalf("%s: %v", c.version, err)
		}
		if got != c.want {
			t.Fatalf("%s >= %d.%d.%d: got %v want %v", c.version, c.maj, c.min, c.pat, got, c.want)
		}
	}
}

func TestServerAtLeastInvalid(t *testing.T) {
	if _, err := ServerAtLeast("not-a-version", 2, 11, 0); err == nil {
		t.Fatal("expected error for unparseable version")
	}
}
