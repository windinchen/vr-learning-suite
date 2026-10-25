#!/bin/bash
# 一键装好打 PICO APK 需要的工具链（全程不需要 sudo）：
#   1. Unity 2022.3.62f3c1（arm64）
#   2. Android 构建支持模块（PlaybackEngines/AndroidPlayer）
#   3. JDK 11（Temurin，Unity 2022.3 要求 11，用 17/21 会报错）
#   4. Android SDK（cmdline-tools + platform-tools + platforms;android-33 + build-tools;33.0.1）
#
# 下载包放哪都行，用环境变量覆盖：
#   UNITY_PKG=... APK_PKG=... ./scripts/install-unity-android.sh
# 已经装好的步骤会自动跳过，可以反复执行。
#
# ⚠️ 注意：本脚本装的是**正版 Unity**，而当前 pico/ 是**团结引擎工程**（ProjectVersion 2022.3.62t16，
# XR 包是 -t2 版），正版 Unity 打不开它。要打这个工程的 APK，得给团结引擎补 Android Build Support；
# 本脚本里的 JDK / Android SDK / NDK 两个编辑器都要用，照旧有用。
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${VR_LAUNCHER_INSTALL_LOG:-/tmp/toolchain-install.log}"
exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') 开始装工具链"

UNITY_VERSION=2022.3.62f3c1
EDITOR_DIR="/Applications/Unity/Hub/Editor/$UNITY_VERSION"
DL=/tmp/unity_dl
SDK="$HOME/Library/Android/sdk"
JDK_HOME="$HOME/tools/jdk-11.0.32.1+1"
PKGUTIL=/usr/sbin/pkgutil

mkdir -p "$DL"

# ---------- 1. Unity 编辑器 ----------
UNITY_PKG="${UNITY_PKG:-$DL/Unity-$UNITY_VERSION-arm64.pkg}"
if [ -d "$EDITOR_DIR/Unity.app" ]; then
  echo "-- Unity 编辑器已存在，跳过"
else
  # 没有本地 pkg 就自己下（约 4.5GB）；机器重装/换机后一条命令就能恢复整套工具链
  if [ ! -f "$UNITY_PKG" ]; then
    echo "-- 下载 Unity 编辑器（约 4.5GB，比较久）"
    curl -fL -o "$UNITY_PKG" "https://download.unitychina.cn/download_unity/1623fc0bbb97/MacEditorInstaller/Unity.pkg"
  fi
  echo "-- 展开 Unity pkg（约 2 分钟）"
  EXPANDED="$DL/unity_expanded"
  "$PKGUTIL" --expand-full "$UNITY_PKG" "$EXPANDED"
  # 真实内容在 <展开目录>/Unity.pkg.tmp/Payload/Unity/Unity.app
  SRC=$(find "$EXPANDED" -maxdepth 6 -name Unity.app -type d | head -1)
  [ -n "$SRC" ] || { echo "❌ 展开后没找到 Unity.app"; exit 1; }
  echo "-- 安装 Unity.app：$SRC"
  mkdir -p "$EDITOR_DIR"
  /bin/cp -R "$SRC" "$EDITOR_DIR/Unity.app"
  du -sh "$EDITOR_DIR/Unity.app"
fi

# ---------- 2. Android 构建支持 ----------
APK_PKG="${APK_PKG:-$DL/android-support.pkg}"
if [ ! -f "$APK_PKG" ]; then
  echo "-- 下载 Android 构建支持（约 680MB）"
  curl -fL -o "$APK_PKG" "https://download.unitychina.cn/download_unity/1623fc0bbb97/MacEditorTargetInstaller/UnitySetup-Android-Support-for-Editor-$UNITY_VERSION.pkg"
fi
if [ -d "$EDITOR_DIR/PlaybackEngines/AndroidPlayer" ]; then
  echo "-- Android 支持已存在，跳过"
else
  echo "-- 展开 Android 支持 pkg"
  AX=/tmp/ax/android
  # pkgutil 不会创建多级目标目录，父目录不存在就直接报错（现象是「展开后没找到 Payload」）
  mkdir -p "$(dirname "$AX")"
  rm -rf "$AX"
  "$PKGUTIL" --expand-full "$APK_PKG" "$AX"
  # 坑：这个 pkg 里还嵌了一层 TargetSupport.pkg，它的 Payload 目录本身就是 AndroidPlayer 的内容，
  # 所以 `find -name AndroidPlayer` 永远找不到（上一版脚本就是这么装出 40GB 废目录的）。
  SRC="$AX/TargetSupport.pkg.tmp/Payload"
  [ -d "$SRC" ] || SRC=$(find "$AX" -maxdepth 4 -type d -name Payload | head -1)
  [ -n "$SRC" ] && [ -d "$SRC" ] || { echo "❌ 展开后没找到 AndroidPlayer 的 Payload"; exit 1; }
  mkdir -p "$EDITOR_DIR/PlaybackEngines"
  /bin/mv "$SRC" "$EDITOR_DIR/PlaybackEngines/AndroidPlayer"
  du -sh "$EDITOR_DIR/PlaybackEngines/AndroidPlayer"
fi
# 正常体积 2GB 上下；要是装成了整盘副本会有几十 GB，直接判失败
SIZE_MB=$(du -sm "$EDITOR_DIR/PlaybackEngines/AndroidPlayer" | cut -f1)
echo "-- AndroidPlayer 体积 ${SIZE_MB} MB"
[ "$SIZE_MB" -lt 8000 ] || { echo "❌ AndroidPlayer 体积异常（疑似误装了根目录副本），请删掉重装"; exit 1; }

# ---------- 3. JDK 11 ----------
if [ -x "$JDK_HOME/Contents/Home/bin/javac" ]; then
  echo "-- JDK 11 已存在，跳过"
else
  echo "-- 安装 JDK 11（Temurin aarch64）"
  curl -fL -o "$DL/jdk11.tar.gz" "https://api.adoptium.net/v3/binary/latest/11/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
  mkdir -p "$HOME/tools"
  /usr/bin/tar -xzf "$DL/jdk11.tar.gz" -C "$HOME/tools"
fi
"$JDK_HOME/Contents/Home/bin/java" -version 2>&1 | head -2

# ---------- 4. Android SDK ----------
mkdir -p "$SDK/cmdline-tools"
if [ -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "-- cmdline-tools 已存在，跳过"
else
  echo "-- 安装 Android SDK 命令行工具"
  curl -fL -o "$DL/cmdline-tools.zip" "https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip"
  /usr/bin/ditto -x -k "$DL/cmdline-tools.zip" "$DL/cmdtools_expanded"
  # zip 里套了一层 cmdline-tools，要放到 SDK/cmdline-tools/latest 才能用
  INNER=$(find "$DL/cmdtools_expanded" -maxdepth 2 -type d -name cmdline-tools | head -1)
  /bin/mv "$INNER" "$SDK/cmdline-tools/latest"
fi
export JAVA_HOME="$JDK_HOME/Contents/Home"
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1
# Unity 2022.3 要求 build-tools ≥ 34、platform ≥ 34、cmdline-tools ≥ 12，只有 33 会在构建时报
# 「Failed to update Android SDK」；IL2CPP 打包还要 NDK（Unity 2022.3 认 r23b）。
"$SDK/cmdline-tools/latest/bin/sdkmanager" \
  "platform-tools" "platforms;android-34" "build-tools;34.0.0" "cmdline-tools;latest" \
  "ndk/23.1.7779620" 2>&1 | tail -3

# ---------- 5. 自检 ----------
echo "-- 自检"
[ -x "$EDITOR_DIR/Unity.app/Contents/MacOS/Unity" ] && echo "  ✅ Unity 编辑器" || echo "  ❌ Unity 编辑器"
[ -d "$EDITOR_DIR/PlaybackEngines/AndroidPlayer" ] && echo "  ✅ Android 播放模块" || echo "  ❌ Android 播放模块"
[ -x "$JAVA_HOME/bin/javac" ] && echo "  ✅ JDK 11" || echo "  ❌ JDK 11"
"$SDK/platform-tools/adb" version | head -1
echo "===== $(date '+%F %T') 完成；接着跑 bash scripts/unity.sh setup 配 SDK 路径 ====="
if [ -f "$ROOT_DIR/pico/ProjectSettings/ProjectVersion.txt" ] && grep -q m_TuanjieEditorVersion "$ROOT_DIR/pico/ProjectSettings/ProjectVersion.txt"; then
  echo "⚠️ 这个工程是团结引擎工程，上面装的正版 Unity 开不了它（包解析会失败）。"
  echo "   打 APK 请给团结引擎装 Android Build Support（团结引擎 Hub 里加模块），JDK/SDK/NDK 可以直接复用上面装好的。"
fi
