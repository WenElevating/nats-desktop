package settings

// Service is the Wails-bound facade (bound as application.NewService).
type Service struct{ Path string }

func NewService(path string) *Service { return &Service{Path: path} }

func (s *Service) GetSettings() (Settings, error) { return Load(s.Path) }

// SaveSettings persists only the user-owned sections. last_active_context is
// server-managed (persisted by main.go on Connect) and must survive a save
// built from a stale frontend draft — hence the merge instead of a full write.
func (s *Service) SaveSettings(v Settings) error {
	return Update(s.Path, func(cur *Settings) {
		cur.Appearance, cur.Behavior, cur.Privacy = v.Appearance, v.Behavior, v.Privacy
	})
}
