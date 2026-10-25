#!/bin/bash
# Unity 命令行入口
#   scripts/unity.sh check   只做 C# 编译体检（headless）
#   scripts/unity.sh setup   生成启动器场景 + 写 Android 打包参数（headless）
#   scripts/unity.sh apk     打 Android APK（headless）→ Build/Android/VR-Launcher.apk
#   scripts/unity.sh shots   无头抓界面截图（-batchmode 带图形设备，不用显示器、不抢前台）
#   scripts/unity.sh play    进播放模式并且编辑器开着，可以用鼠标点着测
#   scripts/unity.sh verify  无头自检：进播放模式跑「读本机应用→上报→拦截」，不需要显示器
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PROJECT="$ROOT/pico"
VERSION_FILE="$PROJECT/ProjectSettings/ProjectVersion.txt"

# 先问工程自己要用哪个编辑器：团结引擎（Tuanjie）的版本号带 t（例如 2022.3.62t16），
# Packages/manifest.json 里的 XR 包也是 -t2 结尾，只有团结引擎的包源里有。
# 拿 Unity Hub 装的正版 Unity 开它会卡在包解析上（Project has invalid dependencies）直接退出，
# 所以按工程声明排挑选顺序，别照安装目录的先后瞎猜——之前就是选错编辑器白跑五分钟还不报原因。
MANIFEST_FILE="$PROJECT/Packages/manifest.json"
PROJECT_VERSION=""
NEEDS_TUANJIE=0
PV_REWRITTEN=0
if [ -f "$VERSION_FILE" ]; then
  PROJECT_VERSION="$(sed -n 's/^m_EditorVersion:[[:space:]]*//p' "$VERSION_FILE" | head -1 | tr -d '[:space:]')"
  if grep -q '^m_TuanjieEditorVersion:' "$VERSION_FILE" || printf '%s' "$PROJECT_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+t[0-9]+$'; then
    NEEDS_TUANJIE=1
  fi
fi
# 正版 Unity 打开过这个工程会把 ProjectVersion.txt 改成自己的版本号，顺带删掉 m_TuanjieEditorVersion 那行，
# 光看声明就会被带偏。包号骗不了人：-t2 这种带 t 的包只有团结引擎的包源里有，见到就按团结引擎工程处理。
if [ "$NEEDS_TUANJIE" = "0" ] && [ -f "$MANIFEST_FILE" ] && LC_ALL=C rg -q '"[0-9]+\.[0-9]+\.[0-9]+-t[0-9]+' "$MANIFEST_FILE"; then
  NEEDS_TUANJIE=1
  PV_REWRITTEN=1
fi

# 找编辑器：UNITY_EDITOR 优先，剩下的按工程声明排顺序（可执行文件名不一样：Unity / Tuanjie）
find_editor() {
  local candidates=()
  if [ "$NEEDS_TUANJIE" = "1" ]; then
    candidates=(
      /Applications/Tuanjie/Tuanjie.app/Contents/MacOS/Tuanjie
      "$HOME"/Applications/Tuanjie/Tuanjie.app/Contents/MacOS/Tuanjie
      /Applications/Unity/Hub/Editor/*/Unity.app/Contents/MacOS/Unity
      /Applications/Unity/Unity.app/Contents/MacOS/Unity
    )
  else
    candidates=(
      /Applications/Unity/Hub/Editor/*/Unity.app/Contents/MacOS/Unity
      /Applications/Unity/Unity.app/Contents/MacOS/Unity
      "$HOME"/Applications/Unity/Hub/Editor/*/Unity.app/Contents/MacOS/Unity
      /Applications/Tuanjie/Tuanjie.app/Contents/MacOS/Tuanjie
    )
  fi
  local candidate
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

EDITOR_EXPLICIT="${UNITY_EDITOR:-}"
EDITOR="${EDITOR_EXPLICIT:-$(find_editor || true)}"
TASK="${1:-check}"; shift || true

HEADLESS=1
METHOD=""
case "$TASK" in
  check) LOG=/tmp/pico_check.log ;;
  setup) LOG=/tmp/pico_setup.log; METHOD="VrLauncher.EditorTools.ProjectBootstrapper.SetupProject" ;;
  apk)   LOG=/tmp/pico_apk.log;   METHOD="VrLauncher.EditorTools.ProjectBootstrapper.BuildApk" ;;
  shots) LOG=/tmp/pico_shots.log; METHOD="VrLauncher.EditorTools.Automation.CaptureScreens"; HEADLESS=0 ;;
  play)  LOG=/tmp/pico_play.log;  METHOD="VrLauncher.EditorTools.Automation.EnterPlayMode";     HEADLESS=0 ;;
  verify) LOG=/tmp/pico_verify.log; METHOD="VrLauncher.EditorTools.Automation.VerifyRuntime";    HEADLESS=2 ;;
  *) echo "用法：scripts/unity.sh <check|setup|apk|shots|play|verify>" >&2; exit 2 ;;
esac

# 编辑器日志里夹着二进制字节，rg 默认当二进制处理会一声不响地不匹配
# （表现是明明有报错却"查不到"），所以查日志一律 -a 强制按文本读。
loghas() { LC_ALL=C rg -qa "$1" "$LOG" 2>/dev/null; }
logrg() { LC_ALL=C rg -a "$@" "$LOG" 2>/dev/null || true; }

# 失败诊断：先挑关键行，挑不出来就把日志尾巴倒出来。
# 以前只挑中文标记，匹配不到时后面是空的，等于零信息，只能自己翻几百 KB 日志。
diag() {
  local hits
  hits="$(logrg -n "$1" | tail -40 | iconv -f utf-8 -t utf-8 -c || true)"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
  else
    echo "（日志里没匹配到关键行，最后 3000 字节如下）"
    LC_ALL=C tail -c 3000 "$LOG" 2>/dev/null | iconv -f utf-8 -t utf-8 -c || true
  fi
}


if [ ! -x "$EDITOR" ]; then
  if [ "$NEEDS_TUANJIE" = "1" ]; then
    echo "❌ 这个工程是团结引擎工程（声明版本 ${PROJECT_VERSION:-未知}），但机器上没找到团结引擎。" >&2
    echo "   装团结引擎 1.10.x（对应 Unity ${PROJECT_VERSION:-2022.3.62t16}），或显式指过去：" >&2
    echo "   UNITY_EDITOR=/Applications/Tuanjie/Tuanjie.app/Contents/MacOS/Tuanjie bash scripts/unity.sh $TASK" >&2
  else
    echo "❌ 找不到 Unity / 团结引擎编辑器。装了的话用 UNITY_EDITOR=/Applications/Unity/Hub/Editor/<版本>/Unity.app/Contents/MacOS/Unity 再跑一次" >&2
  fi
  exit 1
fi

# 选了正版 Unity 开团结引擎工程，必定卡在包解析上。这里先拦住，别跑五分钟才失败。
# 命令行显式给了 UNITY_EDITOR 的当作有意为之，只提醒不拦。
case "$EDITOR" in
  *Tuanjie*) : ;;
  *)
    if [ "$NEEDS_TUANJIE" = "1" ]; then
      echo "⚠️ 工程声明用团结引擎（版本 ${PROJECT_VERSION:-未知}），现在选中的是 $EDITOR"
      if [ -n "$EDITOR_EXPLICIT" ]; then
        echo "   你显式指定了 UNITY_EDITOR，就按你说的跑；包解析过不了就换回团结引擎"
      else
        echo "❌ 正版 Unity 的包源里没有 -t2 版的 XR 包，开这个工程会报「Project has invalid dependencies」。" >&2
        echo "   装团结引擎后重跑，或临时指定：" >&2
        echo "   UNITY_EDITOR=/Applications/Tuanjie/Tuanjie.app/Contents/MacOS/Tuanjie bash scripts/unity.sh $TASK" >&2
        exit 1
      fi
    fi
    ;;
esac

# 编辑器自带的版本号和工程声明的对一下：版本不一致时编辑器会顺手改 Library/工程设置，说清楚点没坏处
EDITOR_VERSION=""
INFO_PLIST="$(dirname "$(dirname "$EDITOR")")/Info.plist"
if [ -f "$INFO_PLIST" ]; then
  # macOS 自带的 sed 不认 GNU 那种分组写法，直接问 PlistBuddy
  EDITOR_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO_PLIST" 2>/dev/null | tr -d '[:space:]')"
fi
echo "工程声明编辑器：${PROJECT_VERSION:-未声明}$([ "$NEEDS_TUANJIE" = "1" ] && printf '（团结引擎工程）')｜实际用：${EDITOR}${EDITOR_VERSION:+（${EDITOR_VERSION}）}"
if [ "$PV_REWRITTEN" = "1" ]; then
  echo "ℹ️ ProjectVersion.txt 里写的是 ${PROJECT_VERSION}，但依赖是 -t2 版的包——这个文件八成是被正版 Unity 打开时改写的，已按团结引擎工程处理"
  echo "   要让声明也对上：把 m_EditorVersion 改回 2022.3.62t16 并补一行 m_TuanjieEditorVersion: 1.10.4；或者干脆只用团结引擎打开这个工程"
fi
if [ -n "$PROJECT_VERSION" ] && [ -n "$EDITOR_VERSION" ] && [ "$PROJECT_VERSION" != "$EDITOR_VERSION" ]; then
  echo "ℹ️ 编辑器版本和工程声明的不一致，第一次打开会花时间重导入资源，工程设置也可能被顺带改写"
fi

# 有没有装 Android 模块（打包要它）。只装 macOS 模块的编辑器照样能做 C# 体检和无头自检，但出不了 APK。
CONTENTS_DIR="$(dirname "$(dirname "$EDITOR")")"
ANDROID_OK=0
[ -d "$CONTENTS_DIR/PlaybackEngines/AndroidPlayer" ] && ANDROID_OK=1
if [ "$ANDROID_OK" = "0" ]; then
  echo "ℹ️ 这个编辑器没装 Android 模块：能做 C# 体检 / 无头自检，但打不了 APK（要打包就去编辑器里装 Android Build Support）"
  if [ "$TASK" = "apk" ]; then
    echo "❌ 打 APK 需要 Android 模块，先装上再跑" >&2
    exit 1
  fi
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# JDK：团结引擎要 17，Android 模块自带的 OpenJDK 就是 17，优先用它；没有再退回 ~/tools 里的 JDK 11
EMBEDDED_JDK=""
for cand in "$CONTENTS_DIR/PlaybackEngines/AndroidPlayer/OpenJDK/Contents/Home" \
            "$CONTENTS_DIR/PlaybackEngines/AndroidPlayer/OpenJDK"; do
  if [ -x "$cand/bin/javac" ]; then EMBEDDED_JDK="$cand"; break; fi
done
export JAVA_HOME="${JAVA_HOME:-${EMBEDDED_JDK:-$HOME/tools/jdk-11.0.32.1+1/Contents/Home}}"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT:-$ANDROID_HOME/ndk/23.1.7779620}"
export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
mkdir -p "$ROOT/Build/Screenshots"
export VRLAUNCHER_SHOT_DIR="$ROOT/Build/Screenshots"
mkdir -p "$ROOT/Build/Android"

# Android 的 Gradle/aapt 不接受非 ASCII 工程路径，而本工作区在「项目任务」目录下。
# 打 APK 时把源码同步到一个纯英文镜像目录里构建（Library 缓存在镜像里长期复用），产物再拷回来。
# pico/ 始终是工作区里唯一的真源码，镜像只是可随时删掉的重建物。
MIRROR_ROOT="$HOME/.cache/vr-pico-build"
BUILD_PROJECT="$PROJECT"
APK_OUT="$ROOT/Build/Android"
if LC_ALL=C printf '%s' "$PROJECT" | LC_ALL=C grep -q '[^ -~]'; then
  if [ "$TASK" = "apk" ]; then
    echo "工程路径含非 ASCII 字符，改用英文镜像构建：$MIRROR_ROOT/pico"
    mkdir -p "$MIRROR_ROOT/pico"
    for part in Assets Packages ProjectSettings; do
      /bin/rm -rf "$MIRROR_ROOT/pico/$part"
      /bin/cp -R "$PROJECT/$part" "$MIRROR_ROOT/pico/$part"
    done
    BUILD_PROJECT="$MIRROR_ROOT/pico"
    mkdir -p "$MIRROR_ROOT/Build/Android"
    APK_OUT="$MIRROR_ROOT/Build/Android"
  fi
fi
export VRLAUNCHER_APK_DIR="$APK_OUT"

# 同一个工程不能双开 Unity：另一个会话在跑时先排队等它结束（最多等 5 分钟）
wait_for_project() {
  target="$1"; waited=0
  pattern="$(printf '%s' "$target" | sed 's/[][\\.*^$+?{}()|]/\\&/g')"
  while pgrep -f "projectPath.*$pattern" >/dev/null 2>&1; do
    if [ "$waited" = "0" ]; then echo "另一个 Unity 实例正占用这个工程，排队等它跑完…"; fi
    if [ "$waited" -ge 900 ]; then echo "❌ 等了 15 分钟工程还是被占着：$target" >&2; exit 3; fi
    sleep 5
    waited=$((waited + 5))
  done
}

FLAGS=(-projectPath "$BUILD_PROJECT" -logFile "$LOG")
if [ "$ANDROID_OK" = "1" ]; then
  FLAGS+=(-buildTarget Android)
fi
if [ "$HEADLESS" = "1" ]; then
  FLAGS=(-batchmode -nographics -quit "${FLAGS[@]}")
  wait_for_project "$BUILD_PROJECT"
  rm -f "$LOG"
  "$EDITOR" "${FLAGS[@]}" ${METHOD:+-executeMethod "$METHOD"} "$@" || true
elif [ "$HEADLESS" = "2" ]; then
  # 无头自检：进播放模式但不渲染；方法自己调 EditorApplication.Exit，所以不能加 -quit
  FLAGS=(-batchmode -nographics "${FLAGS[@]}")
  echo "无头自检中（日志 ${LOG}）…"
  wait_for_project "$BUILD_PROJECT"
  rm -f "$LOG"
  "$EDITOR" "${FLAGS[@]}" ${METHOD:+-executeMethod "$METHOD"} "$@" &
  UNITY_PID=$!
  # 兜底看门狗：最多 300 秒，每 5 秒看一眼，编辑器自己退了立刻收工。
  # 原先写成 ( sleep 300; kill ... ) &，收尾 kill 掉的是那层子 shell，
  # 里面的 sleep 300 变孤儿继续挂着日志管道（表现：脱离运行后像整条链没结束，末尾还甩一行 Terminated）。
  ( for _ in $(seq 1 60); do
      kill -0 "$UNITY_PID" 2>/dev/null || exit 0
      sleep 5
    done
    echo "[兜底] 编辑器 300 秒没结束，强制终止" >&2
    kill -TERM "$UNITY_PID" 2>/dev/null ) &
  WATCHER=$!
  wait "$UNITY_PID" || true
  kill "$WATCHER" 2>/dev/null || true
  # 顺手 wait 收尸：不然脚本退出时会甩一行「Terminated: 15」混进自检输出
  wait "$WATCHER" 2>/dev/null || true
elif [ "$TASK" = "shots" ]; then
  # 抓图要有真实图形设备，但不能依赖窗口：GUI 模式下编辑器窗口不在前台就不推进事件循环，
  # delayCall 永远不触发（现象是日志停在「准备打开场景并进入播放模式」，CPU 0.1%，一张图都出不来）。
  # -batchmode 不带 -nographics 有真的 GfxDevice，离屏渲染照样出图，且不抢前台，稳定得多。
  echo "无头抓图中（有图形设备、不开窗口，日志 ${LOG}）…"
  FLAGS=(-batchmode "${FLAGS[@]}")
  wait_for_project "$BUILD_PROJECT"
  rm -f "$LOG"
  "$EDITOR" "${FLAGS[@]}" ${METHOD:+-executeMethod "$METHOD"} "$@" &
  SHOTS_PID=$!
  # 兜底看门狗：最多 300 秒，每 5 秒看一眼，编辑器自己退了立刻收工。
  # 原先写成 ( sleep 300; kill ... ) &，收尾 kill 掉的是那层子 shell，
  # 里面的 sleep 300 变孤儿继续挂着日志管道（表现：脱离运行后像整条链没结束，末尾还甩一行 Terminated）。
  ( for _ in $(seq 1 60); do
      kill -0 "$SHOTS_PID" 2>/dev/null || exit 0
      sleep 5
    done
    echo "[兜底] 编辑器 300 秒没结束，强制终止" >&2
    kill -TERM "$SHOTS_PID" 2>/dev/null ) &
  WATCHER=$!
  wait "$SHOTS_PID" || true
  kill "$WATCHER" 2>/dev/null || true
  # 顺手 wait 收尸：不然脚本退出时会甩一行「Terminated: 15」混进自检输出
  wait "$WATCHER" 2>/dev/null || true
else
  # 试玩要真实图形界面：不开 -batchmode，也不能开 -quit（否则方法一返回就退出）
  echo "已启动图形界面模式（日志 ${LOG}）；日志里出现「已保存截图」或手动关闭窗口即结束"
  wait_for_project "$BUILD_PROJECT"
  "$EDITOR" "${FLAGS[@]}" ${METHOD:+-executeMethod "$METHOD"} "$@"
  # 图形模式原来是一退出就算成功，抓图半路卡住（比如没接显示器）会一声不响地产不出图
  if loghas "Aborting batchmode due to fatal error"; then
    echo "❌ 这次没能跑起来："
    logrg -A3 "Aborting batchmode due to fatal error" | head -8
    exit 1
  fi
  if [ "$TASK" = "shots" ] && ! loghas "抓图完成"; then
    echo "❌ 没抓到图（日志里看不到「抓图完成」），详见 $LOG"
    exit 1
  fi
  exit 0
fi

# 镜像构建出来的 APK 拷回工作区
if [ "$TASK" = "apk" ] && [ -f "$APK_OUT/VR-Launcher.apk" ] && [ "$APK_OUT" != "$ROOT/Build/Android" ]; then
  /bin/cp "$APK_OUT/VR-Launcher.apk" "$ROOT/Build/Android/VR-Launcher.apk"
  echo "APK 已拷回：$ROOT/Build/Android/VR-Launcher.apk"
fi

if loghas "Project has invalid dependencies"; then
  echo "❌ 工程依赖的包在这个编辑器里找不到，基本就是编辑器选错了（团结引擎工程 ↔ 正版 Unity）："
  logrg -A4 "Project has invalid dependencies" | head -12
  echo "   团结引擎工程用团结引擎跑：UNITY_EDITOR=/Applications/Tuanjie/Tuanjie.app/Contents/MacOS/Tuanjie bash scripts/unity.sh $TASK"
  exit 1
fi
if loghas "Aborting batchmode due to fatal error"; then
  echo "❌ Unity 根本没跑起来："
  logrg -A3 "Aborting batchmode due to fatal error" | head -8
  exit 1
fi
if loghas "error CS"; then
  echo "❌ 有 C# 编译错误："
  logrg "error CS" | sort -u | head -30
  exit 1
fi
if loghas "Invalid project path|Build Finished, Result: Failure"; then
  echo "❌ 构建失败："
  logrg -A2 "Invalid project path|Build Finished, Result: Failure" | head -20
  exit 1
fi
if loghas "Exception: |Unhandled exception|result of 'Failed'"; then
  echo "⚠️ 日志里有异常："
  logrg -n "Exception: |Unhandled exception|result of 'Failed'" | head -10
fi
if [ "$TASK" = "verify" ] && ! loghas "\[验证\] 结果：通过"; then
  echo "❌ 自检没通过，关键日志："
  diag "\[验证\]|\[启动器\]|Invalid dependencies|cannot be found|Aborting batchmode|error CS|Exception: "
  exit 1
fi
if [ "$TASK" = "apk" ] && ! loghas "\[打包\] 结果：Succeeded"; then
  echo "❌ 未看到打包成功标记，关键日志："
  diag "\[打包\]|\[构建\]|error|Aborting"
  exit 1
fi
echo "✅ ${TASK} 通过（详见 ${LOG}）"
