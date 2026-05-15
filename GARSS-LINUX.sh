#!/bin/sh

ROOT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
cd "$ROOT_DIR/garss-studio" || exit 1

run_action() {
  action="$1"

  case "$action" in
    1|start|启动)
      echo "正在启动 GARSS..."
      echo ""
      npm run quick:start -- --open
      return $?
      ;;
    2|stop|关闭)
      echo "正在关闭 GARSS..."
      echo ""
      npm run quick:stop
      return $?
      ;;
    3|upgrade|升级)
      echo "正在升级 GARSS..."
      echo ""
      npm run quick:upgrade -- --open
      return $?
      ;;
    4|status|状态|查看状态)
      echo "正在查看 GARSS 状态..."
      echo ""
      npm run quick:status
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
  printf "请选择操作 [1/2/3/4/5]: "
  read action
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
  printf "按回车返回菜单..."
  read _input
  echo ""
done
