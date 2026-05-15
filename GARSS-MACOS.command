#!/bin/zsh

ROOT_DIR="${0:A:h}"
PROJECT_DIR="$ROOT_DIR/garss-studio"
COMPOSE_FILE="docker-compose.dev.yml"

cd "$PROJECT_DIR" || exit 1

ensure_docker() {
  if ! docker --version >/dev/null 2>&1; then
    echo "请先安装并启动 Docker Desktop。"
    return 1
  fi
}

ensure_env() {
  if [ ! -f ".env" ]; then
    cp ".env.example" ".env"
    echo "已从 .env.example 创建 .env"
  fi
}

entry_url() {
  local access_code
  access_code="$(grep -E '^ACCESS_CODE=' .env 2>/dev/null | head -n 1 | cut -d= -f2-)"
  access_code="${access_code%\"}"
  access_code="${access_code#\"}"
  access_code="${access_code:-banana}"
  echo "http://127.0.0.1:25173/reader?pw=$access_code"
}

open_entry() {
  local url="$1"
  echo "入口: $url"
  open "$url" >/dev/null 2>&1 || echo "无法自动打开浏览器，请手动访问: $url"
}

run_action() {
  local action="$1"
  local url

  case "$action" in
    1|start|启动)
      echo "正在启动 GARSS..."
      echo ""
      ensure_docker || return $?
      ensure_env
      docker compose -f "$COMPOSE_FILE" up --build -d || return $?
      url="$(entry_url)"
      open_entry "$url"
      return 0
      ;;
    2|stop|关闭)
      echo "正在关闭 GARSS..."
      echo ""
      ensure_docker || return $?
      docker compose -f "$COMPOSE_FILE" down
      return $?
      ;;
    3|upgrade|升级)
      echo "正在升级 GARSS..."
      echo ""
      ensure_docker || return $?
      ensure_env
      if [ -d "$ROOT_DIR/.git" ]; then
        docker run --rm -v "$ROOT_DIR:/repo" -w /repo alpine/git pull --ff-only || return $?
      else
        echo "未检测到 .git，跳过代码拉取。"
      fi
      docker compose -f "$COMPOSE_FILE" pull rsshub || return $?
      docker compose -f "$COMPOSE_FILE" up --build -d || return $?
      url="$(entry_url)"
      open_entry "$url"
      return 0
      ;;
    4|status|状态|查看状态)
      echo "正在查看 GARSS 状态..."
      echo ""
      ensure_docker || return $?
      ensure_env
      echo "入口: $(entry_url)"
      echo ""
      docker compose -f "$COMPOSE_FILE" ps
      return $?
      ;;
    5|exit|quit|退出|退出控制台)
      echo "正在退出控制台，GARSS 服务不会被关闭。"
      return 99
      ;;
    *)
      echo "未知操作: $action"
      echo "可用操作: start / stop / upgrade / status / exit"
      return 1
      ;;
  esac
}

if [ -n "$1" ]; then
  run_action "$1"
  exit $?
fi

while true; do
  echo "GARSS"
  echo ""
  echo "1) 启动"
  echo "2) 关闭"
  echo "3) 升级"
  echo "4) 查看状态"
  echo "5) 退出控制台（不关闭服务）"
  echo ""
  read -r "?请选择操作 [1/2/3/4/5]: " action
  echo ""

  run_action "$action"
  exit_code=$?

  if [ "$exit_code" -eq 99 ]; then
    exit 0
  fi

  echo ""
  if [ "$exit_code" -eq 0 ]; then
    echo "操作完成。"
  else
    echo "操作失败，请查看上面的错误信息。"
  fi

  echo ""
  read -r "?按回车返回菜单..."
  echo ""
done
