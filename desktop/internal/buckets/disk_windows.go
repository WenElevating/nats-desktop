//go:build windows

package buckets

import (
	"os/exec"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// defaultDiskFree 返回 path 所在卷的可用字节数（GetDiskFreeSpaceEx 的
// freeBytesAvailableToCaller 口径——感知用户配额）。查询失败 → (0, err)，
// 调用方以 free>0 前置把 0 视为「未知，不阻止」（DownloadObject）。
func defaultDiskFree(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var free uint64
	if err := windows.GetDiskFreeSpaceEx(p, &free, nil, nil); err != nil {
		return 0, err
	}
	return free, nil
}

// OpenInFileManager 在资源管理器中定位并选中 path（§6.9「打开所在目录入口」）：
// explorer /select——零新依赖。explorer 进程异步启动，失败仅为本进程侧错误。
// path 可能由前端以下载目录 + 服务器可控对象名拼出：含 ".." 段的形式会在
// explorer /select 前被拒（transfer.go hasDotDotSegment 同款穿越检测，
// ErrUnsafeName 同款哨兵），保证定位目标不越过用户所选目录。
func (s *BucketService) OpenInFileManager(path string) CallResult {
	if path == "" {
		return fail(CodeValidation, "path must not be empty")
	}
	if hasDotDotSegment(path) {
		return fail(CodeValidation, ErrUnsafeName.Error())
	}
	if err := exec.Command("explorer", "/select,"+filepath.Clean(path)).Start(); err != nil {
		return fail(CodeServer, err.Error())
	}
	return CallResult{}
}
