#!/bin/bash
# 一键自检：① 后台接口全链路 ② 老师网页（真 Chromium）③ PICO 启动器无头自检。
#
# 用法：bash scripts/test.sh           跑全套
#      bash scripts/test.sh api      只跑后台接口（几秒）
#      bash scripts/test.sh web      只跑老师网页（约 20 秒，含抓图）
#      bash scripts/test.sh unity    只跑启动器无头自检（约 2 分钟，要 8787 的后台在跑）
#
# 默认给接口和网页自检各起**一个一次性的后台 + 临时库**（端口 8788，库在 /tmp）：
# 自检会造临时头显、改应用上下架，末尾还要点一次「清空数据」——那些都是老师的数据，
# 拿真的 server/data/suite.db 跑，测完真头显的扫描记录、策略、时长就都没了。
# 要对着某个指定后台跑（比如真机联调）就自己给 BASE，那时候它会照实动那个库：
#      BASE=http://127.0.0.1:8787 bash scripts/test.sh api
cd "$(dirname "$0")/.." || exit 1
WHAT="${1:-all}"
PORT="${SELFTEST_PORT:-8788}"
BASE="${BASE:-}"
BASE_MARK="VR 学习套件"
SELF_PID=""
RUN_DIR=""
status=0
case "$WHAT" in
  all|api|web|unity) ;;
  *)
    echo "不认识的目标「${WHAT}」，可选：all / api / web / unity" >&2
    exit 2
    ;;
esac
TMPROOT="${TMPDIR:-/tmp}"
TMPROOT="${TMPROOT%/}"
# 一次性后台的 PID 记在固定位置：上次自检被中途 Ctrl+C 掉时，trap 可能来不及收尾，
# 端口就被自己人占着，下次直接起不来还以为是环境问题。
PIDFILE="$TMPROOT/vr-selftest-$PORT.pid"

start_private_server() {
  if [ -n "$BASE" ]; then
    curl -sf -o /dev/null "$BASE/" || { echo "指定的后台 $BASE 连不上" >&2; return 1; }
    echo "═══ 用指定后台 ${BASE}（自检会照实改这个库的数据）═══"
    return 0
  fi
  # 端口上还站着上次遗留的一次性后台？先停掉再起，别把「自己挡自己」当成环境问题
  if [ -f "$PIDFILE" ]; then
    STALE="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$STALE" ] && kill -0 "$STALE" 2>/dev/null; then
      echo "上次自检没收尾，先停掉遗留的一次性后台（PID ${STALE}）"
      kill "$STALE" 2>/dev/null
      for _ in $(seq 1 20); do kill -0 "$STALE" 2>/dev/null || break; sleep 0.25; done
    fi
    rm -f "$PIDFILE"
  fi
  RUN_DIR="$(mktemp -d "$TMPROOT/vr-selftest.XXXXXX")"
  echo "═══ 起一次性后台：端口 ${PORT}｜库 $RUN_DIR/suite.db（不碰 server/data/suite.db）═══"
  # exec 让子 shell 变成 node 本身，$! 才是 node 的 PID。
  # 以前写成 ( cd server && node ... & echo $! )，记的是那层子 shell，
  # 收尾 kill 掉子 shell 之后 node 还赖在端口上（表现为「8788 一直被占」）。
  ( cd server && exec env PORT="$PORT" SUITE_DB="$RUN_DIR/suite.db" node src/server.js ) >"$RUN_DIR/server.log" 2>&1 &
  SELF_PID=$!
  printf '%s' "$SELF_PID" > "$RUN_DIR/server.pid"
  for _ in $(seq 1 40); do
    curl -s -m 1 "http://127.0.0.1:${PORT}/" | grep -q "$BASE_MARK" && break
    sleep 0.25
  done
  if ! curl -s -m 1 "http://127.0.0.1:${PORT}/" | grep -q "$BASE_MARK"; then
    echo "一次性后台起不来（端口 $PORT 可能被别的程序占着，换端口：SELFTEST_PORT=8791 bash scripts/test.sh），日志如下：" >&2
    tail -20 "$RUN_DIR/server.log" 2>/dev/null
    return 1
  fi
  printf '%s' "$SELF_PID" > "$PIDFILE"
  BASE="http://127.0.0.1:${PORT}"
  # 把临时库路径交给自检：有两条断言要直接改一下库里的时间（把心跳拨回四分钟前），
  # 光靠接口没法让一台刚刚还在心跳的头显变成「睡着了」
  export SELFTEST_DB="$RUN_DIR/suite.db"
}

# 收尾：停掉一次性后台、删掉临时库。跑挂了就把目录留着，方便看 server.log
cleanup() {
  [ -n "$SELF_PID" ] && kill "$SELF_PID" 2>/dev/null
  rm -f "$PIDFILE"
  if [ -n "$RUN_DIR" ]; then
    if [ "$status" -eq 0 ]; then
      rm -rf "$RUN_DIR"
    else
      echo "（自检没过，临时库和日志留在 ${RUN_DIR}）"
    fi
  fi
}
trap cleanup EXIT
# 中途 Ctrl+C 也要走一遍收尾（bash 一般会把 EXIT trap 补上，这里再兜一道）
trap 'exit 130' INT TERM

if [ "$WHAT" = "all" ] || [ "$WHAT" = "api" ] || [ "$WHAT" = "web" ]; then
  start_private_server || exit 1
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "api" ]; then
  echo "═══ 后台接口自检（${BASE}）═══"
  node scripts/api-test.mjs --base "$BASE" || status=1
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "web" ]; then
  echo
  echo "═══ 老师网页自检（${BASE}）═══"
  BASE="$BASE" bash scripts/web-test.sh || status=1
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "unity" ]; then
  # 启动器自检跑的是真的 Unity 客户端，它连的默认是 8787 那个后台，所以这一段不走临时库
  echo
  echo "═══ PICO 启动器无头自检（读本机应用 → 上报 → 拦截）═══"
  if ! curl -sf -o /dev/null "http://127.0.0.1:8787/"; then
    echo "这一段要 8787 的后台在跑：先 bash scripts/dev.sh" >&2
    status=1
  else
    bash scripts/unity.sh verify || status=1
  fi
fi

echo
if [ "$status" -eq 0 ]; then
  echo "结果：全部通过"
else
  echo "结果：有失败，见上面标 ❌ 的条目"
fi
exit $status
