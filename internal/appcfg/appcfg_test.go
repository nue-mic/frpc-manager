package appcfg

import "testing"

// TestNormalizeListenAddr pins the FRPCMGR_HTTP_ADDR normalization contract:
// bare port -> ":port"; existing host:port pass through; everything we cannot
// confidently interpret is returned as-is WITH a warning (fail-fast, so
// net.Listen reports a real error instead of silently binding the default).
func TestNormalizeListenAddr(t *testing.T) {
	cases := []struct {
		in       string
		wantAddr string
		wantWarn bool
	}{
		// empty -> default, no warning
		{"", ":18080", false},
		// bare port -> prepend colon
		{"18080", ":18080", false},
		{"8443", ":8443", false},
		{" 9001 ", ":9001", false}, // trimmed first
		{"1", ":1", false},
		{"65535", ":65535", false},
		// already host:port -> unchanged, no warning (backward compatible)
		{":18080", ":18080", false},
		{"0.0.0.0:18080", "0.0.0.0:18080", false},
		{"127.0.0.1:18080", "127.0.0.1:18080", false},
		{"192.168.1.1:18080", "192.168.1.1:18080", false},
		{"[::]:18080", "[::]:18080", false},
		{"[::1]:9000", "[::1]:9000", false},
		{"localhost:18080", "localhost:18080", false}, // syntactically valid; bind may still fail
		// out-of-range bare port -> as-is + warn
		{"0", "0", true},
		{"70000", "70000", true},
		{"65536", "65536", true},
		// colon present but port invalid -> as-is + warn
		{":0", ":0", true},
		{":99999", ":99999", true},
		// unrecognized -> as-is + warn
		{"abc", "abc", true},
		{"18080/tcp", "18080/tcp", true},
		{"192.168.1.1", "192.168.1.1", true},             // bare IP, missing port
		{"2001:db8::1:18080", "2001:db8::1:18080", true}, // unbracketed IPv6 -> too many colons
		{"１８０８０", "１８０８０", true},                         // full-width digits must NOT be treated as a port
	}
	for _, c := range cases {
		gotAddr, gotWarn := NormalizeListenAddr(c.in)
		if gotAddr != c.wantAddr {
			t.Errorf("NormalizeListenAddr(%q) addr = %q, want %q", c.in, gotAddr, c.wantAddr)
		}
		if (gotWarn != "") != c.wantWarn {
			t.Errorf("NormalizeListenAddr(%q) warn=%q, wantWarn=%v", c.in, gotWarn, c.wantWarn)
		}
	}
}

// TestIsAllASCIIDigits guards the ASCII-only digit check that keeps full-width
// digits out of the bare-port branch.
func TestIsAllASCIIDigits(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"", false},
		{"0", true},
		{"18080", true},
		{"18080a", false},
		{" 18080", false},
		{"-1", false},
		{"１８０８０", false}, // full-width
	}
	for _, c := range cases {
		if got := isAllASCIIDigits(c.in); got != c.want {
			t.Errorf("isAllASCIIDigits(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
