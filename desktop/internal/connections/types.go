// Package connections provides CRUD over natscontext-backed connection
// profiles ("contexts") that are byte-compatible with the nats CLI's
// context files (spec §17.3 / AC-003).
package connections

// ContextSummary is the read model for a stored context, as shown in
// connection lists and switchers.
type ContextSummary struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	URL         string `json:"url"`
	AuthType    string `json:"auth_type"` // creds | nkey | token | userpass | none
	ColorScheme string `json:"color_scheme"`
}

// ContextForm is the write model used to create or edit a context.
// Empty string fields are skipped when saving, so an edit keeps the
// previously stored value for any field the form leaves empty.
type ContextForm struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	URL           string `json:"url"`
	User          string `json:"user"`
	Password      string `json:"password"`
	Token         string `json:"token"`
	Creds         string `json:"creds"`
	Nkey          string `json:"nkey"`
	Cert          string `json:"cert"`
	Key           string `json:"key"`
	CA            string `json:"ca"`
	JSDomain      string `json:"js_domain"`
	JSAPIPrefix   string `json:"js_api_prefix"`
	JSEventPrefix string `json:"js_event_prefix"`
	InboxPrefix   string `json:"inbox_prefix"`
	SocksProxy    string `json:"socks_proxy"`
	ColorScheme   string `json:"color_scheme"`
	TLSFirst      bool   `json:"tls_first"`
}
