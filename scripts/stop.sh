#!/bin/bash
pkill -f "node src/server.js" && echo "后台服务已停止" || echo "没有正在运行的后台服务"
# 模拟头显（--serve 会一直挂着）也算开发服务的一部分，一起停掉，免得它继续上报时长
pkill -f "scripts/mock-pico.mjs" && echo "模拟头显已停止" || true
