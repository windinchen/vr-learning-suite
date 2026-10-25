#!/bin/bash
# 启动后台服务（已在跑就先停再起），默认端口 8787
cd "$(dirname "$0")/../server"
pkill -f "node src/server.js" 2>/dev/null
sleep 1
PORT="${PORT:-8787}" ../scripts/run-detached.sh /tmp/suite_server.log node src/server.js
sleep 1.5
curl -s -o /dev/null -w "首页 HTTP %{http_code}\n" "http://127.0.0.1:${PORT:-8787}/"
echo "老师端： http://127.0.0.1:${PORT:-8787}   账号 admin / pico123456"
