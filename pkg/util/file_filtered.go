package util

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
)

// ReadFileLinesFiltered 顺序读取整个文件，丢弃所有 filter 返回 false 的行，
// 然后返回过滤后**最后 n 条**（按文件顺序）。
//
// 设计说明：
//   - 对合并日志场景，单实例感兴趣的行通常远少于全文件，先扫一遍再截 N 是
//     最简单可读的实现；用环形缓冲避免一次性把整个 filtered 切片驻留内存。
//   - 文件不存在视作"空日志"（实例从未启动过），不报错，返回空切片。
//   - n <= 0 时被视作"不限制"，全部返回。
//   - filter 为 nil 时全部匹配。
func ReadFileLinesFiltered(path string, n int, filter func(string) bool) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	// 日志单行最大 1 MiB；默认 64 KiB 对长 stack trace 不够。
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	if filter == nil {
		filter = func(string) bool { return true }
	}

	if n <= 0 {
		out := make([]string, 0, 256)
		for scanner.Scan() {
			line := scanner.Text()
			if filter(line) {
				out = append(out, line)
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return out, nil
	}

	// 环形缓冲：固定大小 n，超出后覆盖最旧。
	buf := make([]string, n)
	count, idx := 0, 0
	for scanner.Scan() {
		line := scanner.Text()
		if !filter(line) {
			continue
		}
		buf[idx] = line
		idx = (idx + 1) % n
		count++
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	// 还原顺序：count <= n 时 buf[:count]；否则从 idx 开始环绕
	if count <= n {
		return buf[:count], nil
	}
	out := make([]string, 0, n)
	out = append(out, buf[idx:]...)
	out = append(out, buf[:idx]...)
	return out, nil
}
