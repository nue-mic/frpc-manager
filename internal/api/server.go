package api

import (
	"io/fs"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/mia-clark/frpc-manager/internal/api/middleware"
	"github.com/mia-clark/frpc-manager/internal/appcfg"
	"github.com/mia-clark/frpc-manager/internal/manager"
	"github.com/mia-clark/frpc-manager/web"
)

// Deps bundles the collaborators that handlers need.
type Deps struct {
	Cfg     *appcfg.Config
	Logger  *slog.Logger
	Manager *manager.Manager
}

// NewRouter assembles the chi mux with all middleware and route groups
// installed. It returns an http.Handler ready to be served.
func NewRouter(d Deps) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.Recover(d.Logger))
	r.Use(middleware.AccessLog(d.Logger))
	r.Use(middleware.CORS(d.Cfg.CORSOrigins))

	sys := NewSystemHandler(d.Cfg.DataDir)
	docs := NewDocsHandler(d.Cfg.DocsEnabled)

	// Unauthenticated probes + docs.
	r.Get("/api/v1/health", sys.Health)
	if docs.Enabled() {
		r.Get("/api/docs", docs.Redirect)
		r.Get("/api/docs/", docs.UI)
		r.Get("/api/docs/openapi.yaml", docs.Spec)
		r.Get("/api/docs/openapi.json", docs.SpecJSON)
	}

	configs := NewConfigsHandler(d.Manager, d.Logger)
	proxies := NewProxiesHandler(d.Manager, d.Logger)
	life := NewLifecycleHandler(d.Manager, d.Logger)
	status := NewStatusHandler(d.Manager)
	validate := NewValidateHandler()
	events := NewEventsHandler(d.Manager, d.Logger, d.Cfg.CORSOrigins)
	logs := NewLogsHandler(d.Manager, d.Cfg.LogsDir, d.Logger, d.Cfg.CORSOrigins)
	imex := NewImportExportHandler(d.Manager, d.Logger)
	nat := NewNatholeHandler()
	upd := NewUpdateHandler(d.Cfg.DataDir, d.Cfg.SelfUpdateEnabled, d.Logger)

	// Authenticated subtree.
	r.Group(func(r chi.Router) {
		r.Use(middleware.Bearer(d.Cfg.APIToken))
		r.Get("/api/v1/version", sys.Version)
		r.Get("/api/v1/version/check", upd.Check)
		r.Post("/api/v1/system/update", upd.Update)

		r.Get("/api/v1/configs", configs.List)
		r.Post("/api/v1/configs", configs.Create)
		r.Post("/api/v1/configs/reorder", configs.Reorder)
		r.Get("/api/v1/configs/{id}", configs.Get)
		r.Put("/api/v1/configs/{id}", configs.Update)
		r.Patch("/api/v1/configs/{id}", configs.Patch)
		r.Delete("/api/v1/configs/{id}", configs.Delete)
		r.Post("/api/v1/configs/{id}/duplicate", configs.Duplicate)
		r.Get("/api/v1/configs/{id}/raw", configs.GetRaw)
		r.Put("/api/v1/configs/{id}/raw", configs.PutRaw)

		r.Get("/api/v1/configs/{id}/proxies", proxies.List)
		r.Post("/api/v1/configs/{id}/proxies", proxies.Create)
		r.Get("/api/v1/configs/{id}/proxies/{name}", proxies.Get)
		r.Put("/api/v1/configs/{id}/proxies/{name}", proxies.Update)
		r.Delete("/api/v1/configs/{id}/proxies/{name}", proxies.Delete)
		r.Post("/api/v1/configs/{id}/proxies/{name}/toggle", proxies.Toggle)

		r.Post("/api/v1/configs/{id}/start", life.Start)
		r.Post("/api/v1/configs/{id}/stop", life.Stop)
		r.Post("/api/v1/configs/{id}/reload", life.Reload)
		r.Get("/api/v1/configs/{id}/status", status.Get)

		r.Post("/api/v1/validate", validate.Validate)

		r.Get("/api/v1/configs/{id}/logs", logs.Query)
		r.Get("/api/v1/configs/{id}/logs/files", logs.Files)
		r.Delete("/api/v1/configs/{id}/logs", logs.Clear)
		r.Get("/api/v1/configs/{id}/logs/tail", logs.Tail)

		r.Get("/api/v1/events", events.Subscribe)

		r.Post("/api/v1/import/file", imex.ImportFile)
		r.Post("/api/v1/import/url", imex.ImportURL)
		r.Post("/api/v1/import/text", imex.ImportText)
		r.Post("/api/v1/import/zip", imex.ImportZIP)
		r.Get("/api/v1/configs/{id}/export", imex.ExportConfig)
		r.Get("/api/v1/export/all", imex.ExportAll)

		r.Post("/api/v1/nathole/discover", nat.Discover)

		r.Get("/api/v1/system/info", sys.Info)
		r.Get("/api/v1/system/cpu", sys.CPU)
		r.Get("/api/v1/system/memory", sys.Memory)
		r.Get("/api/v1/system/disk", sys.Disk)
		r.Get("/api/v1/system/network", sys.Network)
		r.Get("/api/v1/system/connections", sys.Connections)
		r.Get("/api/v1/system/process", sys.Process)
	})

	// WebUI 静态文件分发 & SPA 路由兼容
	webFS := web.GetFS()
	fileServer := http.FileServer(http.FS(webFS))

	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		// 如果是未匹配的 api 请求，不应该回退到前端，直接 404
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}

		filePath := strings.TrimPrefix(r.URL.Path, "/")

		// 存在的静态资源（js/css/图片等）交给 FileServer 处理
		if filePath != "" {
			if f, err := webFS.Open(filePath); err == nil {
				f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		// 文件不存在（前端 BrowserRouter 的深链接，如 /configs）→ 直接返回 index.html
		// 让前端路由接管。
		//
		// 注意：不能改写成 r.URL.Path = "/index.html" 再走 FileServer——http.FileServer
		// 会把任何以 /index.html 结尾的请求 301 重定向到 "./"，导致刷新任意子页面都被
		// 重定向回首页。因此这里直接读取并写出 index.html 内容。
		index, err := fs.ReadFile(webFS, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(index)
	})

	return r
}
