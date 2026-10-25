#!/bin/bash
# 给**团结引擎**补齐打 APK 需要的 Android 模块（免 sudo）。
#   打这个工程的 APK 必须要 Android Build Support：Packages/manifest.json 的 XR 包是 -t2 版，
#   只有团结引擎能开这个工程，而团结引擎默认只装了 macOS 模块，`unity.sh apk` 会停在「没装 Android 模块」。
#
# 装两个模块（少一个都打不出包）：
#   android          Android Build Support（919MB pkg）→ PlaybackEngines/AndroidPlayer
#   android-open-jdk OpenJDK 17（107MB zip）→ PlaybackEngines/AndroidPlayer/OpenJDK
#     —— 这个包**不含 JDK**，缺了它构建第一步 Detect Java Development Kit 就抛「JDK not found」，0 秒失败。
#     官方是把它单独做成一个模块放到 AndroidPlayer/OpenJDK，编辑器认它是「随编辑器安装」的 JDK，
#     比拿 JAVA_HOME 去凑省事（而且团结引擎要的是 17，本机那个是 11）。
#
# 模块地址不写死：先读团结引擎 Hub 缓存的 releases.json，按 pico/ProjectSettings 里声明的编辑器版本
# + 本机架构找；Hub 没缓存过就按 changeset 哈希拼地址。
#
# 用法：bash scripts/install-tuanjie-android.sh
#      TJ_MODULES="android" bash scripts/install-tuanjie-android.sh   只装某一个
# 已经装好的会自动跳过，可以反复执行。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EDITOR_APP="${TUANJIE_EDITOR_APP:-/Applications/Tuanjie/Tuanjie.app}"
VERSION_FILE="$ROOT/pico/ProjectSettings/ProjectVersion.txt"
HUB_RELEASES="$HOME/Library/Application Support/TuanjieHub/releases.json"
DL="${TJ_DL_DIR:-/tmp/tuanjie_dl}"
LOG="${TJ_INSTALL_LOG:-/tmp/tuanjie-android-install.log}"
MODULES="${TJ_MODULES:-android android-open-jdk}"
exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') 开始补团结引擎 Android 模块：$MODULES"

[ -d "$EDITOR_APP/Contents/PlaybackEngines" ] || { echo "❌ 没找到团结引擎：$EDITOR_APP（用 TUANJIE_EDITOR_APP=... 指过去）"; exit 1; }
[ -w "$EDITOR_APP/Contents/PlaybackEngines" ] || { echo "❌ 没有写权限：$EDITOR_APP/Contents/PlaybackEngines"; exit 1; }
mkdir -p "$DL"

# ---------- 工程声明的版本 + changeset 哈希 ----------
VERSION=""
HASH=""
if [ -f "$VERSION_FILE" ]; then
  VERSION="$(sed -n 's/^m_EditorVersion:[[:space:]]*//p' "$VERSION_FILE" | head -1 | tr -d '[:space:]')"
  HASH="$(sed -n 's/.*(\([0-9a-f]\{8,\}\)).*/\1/p' "$VERSION_FILE" | head -1)"
fi
echo "-- 工程声明编辑器版本：${VERSION:-未知}｜changeset：${HASH:-未知}"

# 从 Hub 缓存里按「模块 id + 版本 + 本机架构」捞：地址、校验和、落地位置
lookup() {
  python3 - "$HUB_RELEASES" "$1" "$VERSION" "$(uname -m)" <<'PYPY'
import json, sys, re
path, want_id, want_ver, machine = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
arch = "arm64" if machine == "arm64" else "x86_64"
data = json.load(open(path, encoding="utf-8"))
releases = [r for r in data.get("official", []) + data.get("beta", []) if r.get("version") == want_ver]
if not releases:
    # 声明版本查不到（多半是被正版 Unity 打开时改写过）：退回缓存里最新的那条
    def key(rel):
        return [int(n) for n in re.findall(r"\d+", str(rel.get("version", "")))]
    releases = sorted(data.get("official", []), key=key, reverse=True)[:1]
    if releases:
        sys.stderr.write("  声明版本 %s 不在 Hub 缓存里，改用 %s\n" % (want_ver, releases[0].get("version")))
for rel in releases:
    if rel.get("arch") not in (arch, None):
        continue
    for m in rel.get("modules", []):
        if m.get("id") == want_id:
            print("%s\t%s\t%s" % (m.get("downloadUrl", ""), m.get("checksum", ""), m.get("destination", "")))
            sys.exit(0)
print("\t\t")
PYPY
}

STATUS=0
for MODULE in $MODULES; do
  echo ""
  echo "──── 模块 $MODULE"
  case "$MODULE" in
    android)
      DEST="$EDITOR_APP/Contents/PlaybackEngines/AndroidPlayer"
      DONE_IF="-d"
      ;;
    android-open-jdk)
      DEST="$EDITOR_APP/Contents/PlaybackEngines/AndroidPlayer/OpenJDK"
      DONE_IF="-x"
      ;;
    *)
      echo "❌ 不认识的模块：$MODULE"; STATUS=1; continue ;;
  esac
  if [ "$DONE_IF" = "-d" ] && [ -d "$DEST" ]; then
    echo "-- 已就位，跳过：$DEST"; continue
  fi
  if [ "$DONE_IF" = "-x" ] && [ -x "$DEST/Contents/Home/bin/javac" ]; then
    echo "-- 已就位，跳过：$DEST"; continue
  fi

  LINE="$(lookup "$MODULE")"
  URL="$(printf '%s' "$LINE" | cut -f1)"
  EXPECT="$(printf '%s' "$LINE" | cut -f2)"
  RAW_DEST="$(printf '%s' "$LINE" | cut -f3)"
  [ -n "$URL" ] || { echo "❌ Hub 缓存里没找到模块 $MODULE（版本 $VERSION）"; STATUS=1; continue; }
  echo "-- 地址：$URL"
  [ -z "$RAW_DEST" ] || echo "-- 官方落地位置：$RAW_DEST"

  # ---------- 下载（支持断点续传）----------
  FILE="$DL/$(basename "$URL")"
  if [ ! -f "$FILE" ]; then
    echo "-- 下载中：$FILE"
    curl -fL -C - --retry 3 --retry-delay 5 -o "$FILE" "$URL" || { echo "❌ 下载失败"; STATUS=1; continue; }
  fi
  ls -lh "$FILE" | awk '{print "-- 包大小：" $5}'
  if [ -n "$EXPECT" ]; then
    GOT="$(md5 -q "$FILE")"
    echo "-- 校验 md5：期望 $EXPECT｜实际 $GOT"
    if [ "$GOT" != "$EXPECT" ]; then
      echo "-- 校验不过（续传拼接容易出这问题），删掉重下"
      python3 -c "import os,sys; os.remove(sys.argv[1])" "$FILE"
      curl -fL --retry 3 --retry-delay 5 -o "$FILE" "$URL" || { echo "❌ 重下失败"; STATUS=1; continue; }
      GOT="$(md5 -q "$FILE")"
      [ "$GOT" = "$EXPECT" ] || { echo "❌ 重下还是不对：$GOT"; STATUS=1; continue; }
    fi
  fi

  # ---------- 解开：pkg 用 pkgutil，zip 直接解 ----------
  SRC=""
  case "$FILE" in
    *.pkg)
      EXPANDED="$DL/$(basename "$FILE" .pkg)_expanded"
      if [ ! -d "$EXPANDED" ]; then
        echo "-- 展开 pkg（要几分钟）"
        pkgutil --expand-full "$FILE" "$EXPANDED" || { echo "❌ 展开失败"; STATUS=1; continue; }
      fi
      # 这种包的 Payload 本身就是模块内容（Tools/Apk/Bee/Variations…），老包会多套一层目录名
      PAYLOAD="$(find "$EXPANDED" -maxdepth 4 -type d -name Payload | head -1)"
      [ -n "$PAYLOAD" ] || { echo "❌ 没找到 Payload"; ls -R "$EXPANDED" | head -30; STATUS=1; continue; }
      INNER="$(find "$PAYLOAD" -maxdepth 1 -mindepth 1 -type d | head -1)"
      if [ -d "$PAYLOAD/Variations" ] || [ -d "$PAYLOAD/Tools" ]; then
        SRC="$PAYLOAD"
      elif [ -n "$INNER" ] && { [ -d "$INNER/Variations" ] || [ -d "$INNER/Tools" ]; }; then
        SRC="$INNER"
      else
        echo "❌ $PAYLOAD 看着不像 Android 播放模块"; ls "$PAYLOAD" | head -20; STATUS=1; continue
      fi
      ;;
    *.zip)
      EXPANDED="$DL/$(basename "$FILE" .zip)_expanded"
      if [ ! -d "$EXPANDED" ]; then
        echo "-- 解压 zip"
        mkdir -p "$EXPANDED"
        /usr/bin/ditto -x -k "$FILE" "$EXPANDED" || { echo "❌ 解压失败"; STATUS=1; continue; }
      fi
      # 认 JDK 根目录的依据就是 bin/javac 在不在：这个包的 zip 是平铺的（bin/ lib/ 直接在根），
      # 别的版本可能套一层 jdk-17.x.x 或 Contents/Home，所以按文件找，不认目录名。
      JAVAC="$(find "$EXPANDED" -maxdepth 6 -type f -name javac -path '*/bin/javac' | head -1)"
      [ -n "$JAVAC" ] || { echo "❌ 解压后没找到 bin/javac"; find "$EXPANDED" -maxdepth 3 | head -20; STATUS=1; continue; }
      SRC="$(dirname "$(dirname "$JAVAC")")"
      ;;
    *) echo "❌ 不支持的包类型：$FILE"; STATUS=1; continue ;;
  esac
  echo "-- 模块内容：$SRC"

  mkdir -p "$(dirname "$DEST")"
  /usr/bin/ditto "$SRC" "$DEST" || { echo "❌ 拷到 $DEST 失败"; STATUS=1; continue; }
  # 目录惯例两种都得能满足：这个 zip 是 OpenJDK/bin/javac，macOS 惯例是 OpenJDK/Contents/Home/bin/javac，
  # 补一个 Contents/Home 指回本目录，两种查法都命中（编辑器版本之间改过这个查法，不值得赌）
  if [ -x "$DEST/bin/javac" ]; then
    mkdir -p "$DEST/Contents"
    ln -sfn "$DEST" "$DEST/Contents/Home"
  fi
  echo "-- 已装到：$DEST"
done

# ---------- 自检 ----------
echo ""
echo "──── 自检"
AP="$EDITOR_APP/Contents/PlaybackEngines/AndroidPlayer"
[ -d "$AP" ] && echo "  ✅ AndroidPlayer 已就位" || { echo "  ❌ AndroidPlayer 缺失"; STATUS=1; }
{ [ -d "$AP/Tools/gradle" ] || [ -d "$AP/Tools/Gradle" ]; } && echo "  ✅ 自带 Gradle" || echo "  ℹ️ 没看到自带 Gradle"
[ -d "$AP/Variations/il2cpp" ] && echo "  ✅ 带 IL2CPP 构建参数" || echo "  ℹ️ 没看到 Variations/il2cpp"
JAVA_HOME_DIR=""
for cand in "$AP/OpenJDK/bin/javac" "$AP/OpenJDK/Contents/Home/bin/javac"; do
  [ -x "$cand" ] && JAVA_HOME_DIR="$(dirname "$(dirname "$cand")")" && break
done
if [ -n "$JAVA_HOME_DIR" ]; then
  echo "  ✅ 自带 OpenJDK：$("$JAVA_HOME_DIR/bin/javac" -version 2>&1 | head -1)｜$JAVA_HOME_DIR"
else
  echo "  ❌ 自带 OpenJDK 缺失（构建会报 JDK not found）"; STATUS=1
fi
du -sh "$AP" 2>/dev/null
[ "$STATUS" = "0" ] && echo "===== 完成，接着跑 bash scripts/unity.sh apk 打包 =====" || echo "===== 有模块没装上，看上面的 ❌ ====="
exit "$STATUS"
