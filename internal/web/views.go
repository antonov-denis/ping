package web

import (
	"bytes"
	"embed"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
)

//go:embed views/*.html
var viewFS embed.FS

//go:embed static
var staticFS embed.FS

var views = template.Must(template.ParseFS(viewFS, "views/*.html"))

func staticFiles() http.Handler {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}
	return http.StripPrefix("/static/", http.FileServerFS(sub))
}

func (s *Server) render(w http.ResponseWriter, status int, name string, data any) {
	var buf bytes.Buffer
	if err := views.ExecuteTemplate(&buf, name, data); err != nil {
		slog.Error("render failed", "view", name, "err", err)
		http.Error(w, "Something Went Wrong", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	buf.WriteTo(w)
}
