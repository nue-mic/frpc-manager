# syntax=docker/dockerfile:1.7
#
# 三阶段构建：
#   1. web-build  —— node:20-alpine 跑 vite build，产出 web/dist
#   2. build       —— golang:1.25-alpine 把 dist 接进来，go build 单二进制
#                     (前端通过 //go:embed dist 嵌入 frpmgrd)
#   3. runtime     —— alpine:3.20 + su-exec，只装 frpmgrd 这一个产物
#
# 设计目标：在任何环境（CI / 干净 git clone / 本地）都能直接
# `docker build -f deploy/Dockerfile .`，不需要任何前置 npm/make 步骤。
# .dockerignore 已排除 web/dist —— 永远从 web-build 阶段生成新鲜的产物。

# ----- web build stage --------------------------------------------------
FROM node:20-alpine AS web-build
WORKDIR /web

# 单独 COPY package*.json 让 npm ci 这一层尽量命中缓存
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

# 拷剩余源码后 build
COPY web/ ./
RUN npm run build

# ----- go build stage ---------------------------------------------------
FROM golang:1.25-alpine AS build
WORKDIR /src
RUN apk add --no-cache git ca-certificates tzdata

COPY go.mod go.sum ./
RUN go mod download

COPY . .
# 用 web-build 阶段产物覆盖（dockerignore 已排除根上下文里的 web/dist），
# //go:embed dist 现在能拿到完整、最新的前端
COPY --from=web-build /web/dist ./web/dist

ARG VERSION=dev
ARG BUILD_DATE=unknown
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w \
      -X github.com/mia-clark/frp-manager-server/pkg/version.Number=${VERSION} \
      -X github.com/mia-clark/frp-manager-server/pkg/version.BuildDate=${BUILD_DATE}" \
    -o /out/frpmgrd ./cmd/frpmgrd

# ----- runtime stage ----------------------------------------------------
# alpine + su-exec, the same pattern the official postgres/redis images
# use: start as root, fix /data ownership, drop privileges, exec daemon.
# Trade ~5MB of base image size for a self-contained init flow (no
# sidecar, no host-side chown) that works for both named volumes and
# host bind mounts.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata su-exec \
    && addgroup -g 65532 -S nonroot \
    && adduser -u 65532 -G nonroot -S -D -H nonroot

COPY --from=build /out/frpmgrd /usr/local/bin/frpmgrd
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/frpmgrd

ENV FRPMGR_DATA_DIR=/data \
    FRPMGR_HTTP_ADDR=:8080 \
    FRPMGR_LOG_LEVEL=info \
    FRPMGR_CORS_ORIGINS="*"

EXPOSE 8080
VOLUME ["/data"]

# Intentionally no USER directive — entrypoint.sh starts as root just
# long enough to chown /data, then re-execs as UID 65532 via su-exec.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
