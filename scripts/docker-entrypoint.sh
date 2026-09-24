#!/bin/sh
# 컨테이너 시작: 데이터 폴더(DB 위치)를 앱 사용자(node)가 쓸 수 있게 만든 뒤 권한을 낮춰 실행한다.
# (Render 디스크·도커 볼륨은 처음에 root 소유로 붙을 수 있기 때문)
set -e
DATA_DIR="$(dirname "${DB_PATH:-/data/meet.db}")"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
