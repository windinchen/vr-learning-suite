#!/bin/bash
# 用 python 的 start_new_session 真正脱离当前进程组，避免命令会话结束时把长任务一起带走
# 用法：scripts/run-detached.sh <日志文件> <命令...>
LOG="$1"; shift
exec /usr/bin/python3 - "$LOG" "$@" <<'PY'
import subprocess, sys, os
log_path, *cmd = sys.argv[1:]
handle = open(log_path, "ab", buffering=0)
child = subprocess.Popen(cmd, stdout=handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         start_new_session=True, cwd=os.getcwd())
print(f"已脱离启动 PID={child.pid}  日志={log_path}")
PY
