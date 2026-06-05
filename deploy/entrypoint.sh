#!/bin/sh
# frpcmgrd container entrypoint.
#
# Runs as root just long enough to make sure /data is owned by the
# non-root runtime user (UID 65532), then re-execs the daemon as that
# user. Works for both named volumes and host bind mounts — no sidecar
# or host-side chown ritual required.
set -e

DATA_DIR="${FRPCMGR_DATA_DIR:-/data}"
RUN_UID=65532
RUN_GID=65532

# Healthcheck and other non-serve invocations don't need to touch /data,
# and we want them to be cheap. Run them straight as the non-root user.
case "${1:-}" in
    serve|"")
        mkdir -p "${DATA_DIR}/profiles" "${DATA_DIR}/logs" "${DATA_DIR}/stores"
        # Only chown when ownership is actually wrong — keeps restarts fast
        # and avoids touching files on read-only mounts.
        if [ "$(stat -c '%u' "${DATA_DIR}")" != "${RUN_UID}" ]; then
            chown -R "${RUN_UID}:${RUN_GID}" "${DATA_DIR}"
        fi
        ;;
esac

# If we're already non-root (e.g. user overrode `user:` in compose),
# just exec directly.
if [ "$(id -u)" != "0" ]; then
    exec /usr/local/bin/frpcmgrd "$@"
fi

exec su-exec "${RUN_UID}:${RUN_GID}" /usr/local/bin/frpcmgrd "$@"
