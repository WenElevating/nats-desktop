package settings

// Service is the Wails-bound facade (bound as application.NewService).
type Service struct{ Path string }

func NewService(path string) *Service { return &Service{Path: path} }

func (s *Service) GetSettings() (Settings, error) { return Load(s.Path) }

func (s *Service) SaveSettings(v Settings) error { return Save(s.Path, v) }
