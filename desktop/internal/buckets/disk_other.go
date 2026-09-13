//go:build !windows

package buckets

// defaultDiskFree 非 Windows 桩：(0, nil) = 未知——DownloadObject 的磁盘预检以
// free>0 为前置，0 永不阻止（brief 红字：漏掉前置会让非 Windows 全部下载被拒）。
func defaultDiskFree(string) (uint64, error) { return 0, nil }

// OpenInFileManager 非 Windows 桩：§6.9「打开所在目录入口」仅 Windows Explorer
// /select 实装（零新依赖），其余平台 validation 文案。
func (s *BucketService) OpenInFileManager(path string) CallResult {
	return fail(CodeValidation, "not supported on this platform")
}
