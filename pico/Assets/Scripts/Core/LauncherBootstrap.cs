using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using VrLauncher.Integration;

namespace VrLauncher.Core
{
    /// <summary>
    /// 启动器主控：登记 → 拉清单 → 前台计时 → 心跳 → 上报时长，循环执行，同时处理后台下发的指令。
    /// 任何一次网络失败都只记录状态、不中断循环：断网时继续按最后一次策略执行，联网后补报时长。
    /// </summary>
    [DefaultExecutionOrder(-100)]
    public class LauncherBootstrap : MonoBehaviour
    {
        public const string SelfPackageName = "com.school.vr.launcher";
        const int LogCapacity = 150;

        public static LauncherBootstrap Instance { get; private set; }

        UsageRecorder usage;
        readonly List<string> entries = new List<string>();

        ManifestResponse manifest;
        string pairingCode = "";
        // 拿到的那份清单对应后台哪个改动版本：心跳一比就知道老师是不是刚改过东西
        long manifestRev = -1;
        string simulatedAppKey = "";
        bool refreshing;
        int round;
        LocalAppScanner localApps;
        bool localDirty;
        bool syncingApps;
        string unmanagedPackage = "";
        int unmanagedStreak;
        IdentityServer identity;
        const int LocalScanEveryRounds = 30;
        // 连着连不上后台就自己扫网段找（见 BackendFinder）：两次失败起扫，越扫不到扫得越稀
        readonly BackendFinder backends = new BackendFinder();
        const int SearchAfterFailedRounds = 2;
        float searchCooldown = 60f;
        float lastSearchAt = -1000f;

        // 老师在网页上「弹一句话给头显」发来的话：显示几十秒后自己退回去，不用谁去关
        const float TeacherMessageSeconds = 45f;
        string teacherMessage = "";
        // Time.realtimeSinceStartupAsDouble 是 double：存到 float 会丢精度，编译器也不让隐式转
        double teacherMessageUntil = -1d;

        int screenLessonId;
        int screenBusy;
        int screenFrames;
        int screenFailures;
        int screenIntervalMs = 1500;
        string screenError = "";
        DateTime lastScreenAt = DateTime.MinValue;
        float nextScreenAt;

        /// <summary>界面重绘信号：任何状态变化后触发。</summary>
        public event Action StateChanged;

        public ManifestResponse Manifest => manifest;
        public UsageRecorder Usage => usage;
        public string StatusText { get; private set; } = "准备中";
        public string LastError { get; private set; } = "";
        public bool Online { get; private set; }
        public int FailedRounds { get; private set; }
        public string PairingCode => pairingCode;
        public string ServerUrl => LauncherConfig.ServerBaseUrl;
        public string Serial => LauncherConfig.DeviceSerial;
        public bool HasToken => !string.IsNullOrEmpty(LauncherConfig.DeviceToken);
        public IReadOnlyList<string> LogEntries => entries;
        public string ForegroundPackage { get; private set; } = "";
        public int ViolationCount { get; private set; }

        /// <summary>老师刚发来的那句话；超过 45 秒就当看过了，回空字符串。</summary>
        public string TeacherMessage => TeacherMessageVisible ? teacherMessage : "";

        public bool TeacherMessageVisible =>
            !string.IsNullOrEmpty(teacherMessage) && Time.realtimeSinceStartupAsDouble < teacherMessageUntil;

        /// <summary>本机应用清单（真机扫描结果或 PC 模拟清单）。</summary>
        public LocalAppScanner Local => localApps;

        public IReadOnlyList<LocalAppRecord> LocalApps =>
            localApps == null ? Array.Empty<LocalAppRecord>() : localApps.Apps;

        public string AppMode => manifest != null && !string.IsNullOrEmpty(manifest.mode) ? manifest.mode : "allowlist";

        /// <summary>白名单模式：清单外的应用一打开就送回桌面。老师在后台可以切成自由运行。</summary>
        public bool StrictMode => AppMode != "open";

        public bool LocalSimulated => localApps != null && localApps.Simulated;

        public string LocalScanLine => localApps != null && localApps.Scanned
            ? localApps.ScannedAt.ToString("HH:mm:ss") + " 扫描｜共 " + localApps.Apps.Count + " 个"
            : "还没扫描本机应用";

        /// <summary>设置页里那一行：自动找后台扫过没有、找到没找到。</summary>
        public string BackendSearchLine => backends == null ? "" : backends.StatusLine;

        /// <summary>正在扫网段：设置页据此把按钮变成「扫描中」，别让老师连点。</summary>
        public bool BackendSearching => backends != null && backends.IsRunning;

        /// <summary>手里这份清单对应后台第几版改动（0/负数＝后台太旧没给版本号）。</summary>
        public long ManifestRev => manifestRev;

        public int MissingInstallCount
        {
            get
            {
                var count = 0;
                foreach (var app in Apps)
                {
                    if (app != null && app.installState == "missing")
                    {
                        count += 1;
                    }
                }

                return count;
            }
        }

        /// <summary>这台头显装没装这个应用（后台没扫描过时按「装了」处理，不误报）。</summary>
        public bool IsInstalled(AppItem app)
        {
            return app == null || app.installState != "missing";
        }

        public bool IsLocked => manifest != null && manifest.locked != null && manifest.locked.locked;
        public string LockReason => manifest != null && manifest.locked != null ? manifest.locked.reason : "";
        public bool HasStudent => manifest != null && manifest.student != null && manifest.student.id > 0;
        public string StudentName => HasStudent ? manifest.student.name : "未绑定学生";
        public string StudentNo => HasStudent ? manifest.student.studentNo : "待老师在网页上绑定";
        /// <summary>这台头显现在在不在一节正在上的课里。</summary>
        public bool InLesson => manifest != null && manifest.lesson != null && manifest.lesson.active;

        public LessonInfo Lesson => InLesson ? manifest.lesson : null;

        public string LessonTitle => InLesson && !string.IsNullOrEmpty(manifest.lesson.title) ? manifest.lesson.title : "未命名的一节课";

        public string LessonClass => InLesson && !string.IsNullOrEmpty(manifest.lesson.className) ? manifest.lesson.className : "不分班";

        public string LessonTeacher => InLesson && !string.IsNullOrEmpty(manifest.lesson.teacher) ? manifest.lesson.teacher : "老师";

        public bool LessonHasStudent => InLesson && manifest.lesson.student != null && manifest.lesson.student.id > 0;

        public string LessonStudentName => LessonHasStudent ? manifest.lesson.student.name : "老师还没定";

        public string LessonStudentNo => LessonHasStudent ? manifest.lesson.student.studentNo : "";

        /// <summary>这节课单独限定了几个应用（0 = 跟后台整份清单一致）。</summary>
        public int LessonAppLimit => InLesson && manifest.lesson.appKeys != null ? manifest.lesson.appKeys.Length : 0;

        public long LessonElapsedSeconds
        {
            get
            {
                if (!InLesson || manifest.lesson.startedAt <= 0L)
                {
                    return 0L;
                }

                return Math.Max(0L, (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc))
                    .TotalSeconds - manifest.lesson.startedAt / 1000L);
            }
        }

        /// <summary>顶栏横幅：上课中《课程》· 班级 · 老师 · 已上时长 · 画面状态。</summary>
        public string LessonLine
        {
            get
            {
                if (!InLesson)
                {
                    return "";
                }

                return "上课中《" + LessonTitle + "》· " + LessonClass
                    + " · 已上 " + HumanSpan(LessonElapsedSeconds)
                    + (ScreenEnabled ? " · 画面回传中" : "");
            }
        }

        public bool ScreenEnabled => InLesson && manifest.lesson.screen != null && manifest.lesson.screen.enabled;

        public int ScreenIntervalMs => screenIntervalMs;

        public int ScreenFrames => screenFrames;

        public int ScreenFailures => screenFailures;

        /// <summary>给状态卡用的一行短状态。</summary>
        public string ScreenShort
        {
            get
            {
                if (!InLesson)
                {
                    return "没上课不回传";
                }

                if (!ScreenEnabled)
                {
                    return "这节课没开画面";
                }

                if (lastScreenAt == DateTime.MinValue)
                {
                    return string.IsNullOrEmpty(screenError) ? "等第一帧画面" : "画面失败";
                }

                return "已传 " + screenFrames + " 帧｜" + lastScreenAt.ToString("HH:mm:ss");
            }
        }

        public string ScreenLine
        {
            get
            {
                if (!InLesson)
                {
                    return "没上课，不回传画面";
                }

                if (!ScreenEnabled)
                {
                    return "这节课没开画面回传";
                }

                return lastScreenAt == DateTime.MinValue
                    ? (string.IsNullOrEmpty(screenError) ? "等第一帧画面…" : "画面没传上去：" + screenError)
                    : "已传 " + screenFrames + " 帧｜最近 " + lastScreenAt.ToString("HH:mm:ss")
                        + (screenFailures > 0 ? "｜失败 " + screenFailures + " 次" : "");
            }
        }

        static string HumanSpan(long seconds)
        {
            if (seconds < 60L)
            {
                return seconds + " 秒";
            }

            return seconds / 60L + " 分 " + seconds % 60L + " 秒";
        }

        public string DeviceLabel => manifest != null && manifest.device != null && !string.IsNullOrEmpty(manifest.device.name)
            ? manifest.device.name
            : LauncherConfig.DeviceName;

        public int AppCount => manifest != null && manifest.apps != null ? manifest.apps.Length : 0;

        /// <summary>
        /// 到底拿到过后台的清单没有。空清单和「压根没连上后台」是两码事：
        /// 前者是老师把应用都停了／还没扫出应用，后者才是网络问题，横幅上得说得不一样。
        /// </summary>
        public bool HasManifest => manifest != null;

        public AppItem[] Apps
        {
            get
            {
                if (manifest == null || manifest.apps == null)
                {
                    return Array.Empty<AppItem>();
                }

                return manifest.apps;
            }
        }

        void Awake()
        {
            if (Instance != null && Instance != this)
            {
                Destroy(gameObject);
                return;
            }

            Instance = this;
            DontDestroyOnLoad(gameObject);
            // Unity 默认一失焦就暂停：学生点开别的 VR 应用、或在 PC 上用窗口跑启动器时一切换窗口，
            // 心跳和前台计时会整个停住，后台那头就显示这台「离线」。先把这个默认关掉。
            Application.runInBackground = true;
            // 别让它打盹：头显一入睡，心跳和 8790 问话口一起停——后台显示离线、网页「按 IP 找头显」
            // 也变成「问了没回」，老师在两头都查不出原因。代价是费点电，管控用的启动器认这个账。
            Screen.sleepTimeout = SleepTimeout.NeverSleep;
            // persistentDataPath 不能在字段初始化时读，必须等 Awake
            usage = new UsageRecorder();
            localApps = new LocalAppScanner();
            Note("启动器 v" + LauncherConfig.AppVersion + " 已启动");
        }

        void Start()
        {
            StartCoroutine(MainLoop());
            StartCoroutine(ScreenLoop());
            StartIdentity();
        }

        void OnDisable()
        {
            if (usage != null)
            {
                usage.SealRunning();
                usage.Save();
            }
        }

        void OnApplicationPause(bool paused)
        {
            if (paused && usage != null)
            {
                TrackForeground();
                usage.SealRunning();
                usage.Save();
            }

            // 刚从别的应用回到启动器：先问后台要一份最新清单，老师刚放开的应用这才算真能点开
            if (!paused && HasToken)
            {
                Note("回到前台，重新要一份清单");
                StartCoroutine(RefreshManifest());
            }
        }

        void Update()
        {
            // 老师在网页上按了「让它连上后台」：地址是 HTTP 线程收下的，改配置和重连回主线程做
            var pushed = identity == null ? null : identity.TakePendingBackend();
            if (!string.IsNullOrEmpty(pushed) && pushed != LauncherConfig.ServerBaseUrl)
            {
                ApplyServerUrl(pushed);
            }

            // 自动找后台的扫描在别的线程上跑，扫完在这儿收口（改配置、刷界面都得回主线程）
            var found = backends.TakeFinished();
            if (found != null)
            {
                HandleBackendSearch(found);
            }
        }

        void OnDestroy()
        {
            if (identity != null)
            {
                identity.Dispose();
                identity = null;
            }

            if (Instance == this)
            {
                Instance = null;
            }
        }

        // ---------- 按 IP 找头显：本机问话口 ----------
        /// <summary>
        /// 开一个只答不写的小服务：老师的电脑不用先在后台录序列号，直接敲这台头显的 IP 就能认领它。
        /// 开不开都不影响主流程，失败了只在日志里说一声，照旧可以手填序列号登记。
        /// </summary>
        void StartIdentity()
        {
            identity = new IdentityServer();
            identity.Start(IdentityServer.DefaultPort);
            PublishIdentity();
            Note("按 IP 找头显：" + IdentityLine);
        }

        /// <summary>把「这台是谁、装着什么」抄一份给问话口；状态一变就重抄，老师问到的不会是老数据。</summary>
        public void PublishIdentity()
        {
            if (identity == null || !identity.IsRunning)
            {
                return;
            }

            var level = SystemInfo.batteryLevel;
            identity.Publish(
                LauncherConfig.DeviceSerial,
                DeviceLabel,
                LauncherConfig.DeviceModel,
                LauncherConfig.AppVersion,
                ForegroundPackage,
                level < 0f ? -1 : Mathf.RoundToInt(level * 100f),
                LocalApps,
                LauncherConfig.ServerBaseUrl,
                Online,
                Online ? "" : LastError);
        }

        /// <summary>设置页里给老师看的一行：本机问话口开在哪、答过几次。</summary>
        public string IdentityLine => identity == null ? "没开" : identity.StatusLine;

        // ---------- 主循环 ----------
        IEnumerator MainLoop()
        {
            var manifestEvery = Mathf.Max(1, Mathf.RoundToInt(LauncherConfig.ManifestSeconds / (float) LauncherConfig.HeartbeatSeconds));
            var flushEvery = Mathf.Max(1, Mathf.RoundToInt(LauncherConfig.FlushUsageSeconds / (float) LauncherConfig.HeartbeatSeconds));

            while (true)
            {
                if (!HasToken)
                {
                    yield return Enroll();
                }

                if (round % manifestEvery == 0)
                {
                    yield return RefreshManifest();
                }

                if (!localApps.Scanned || round % LocalScanEveryRounds == 0)
                {
                    ScanLocalApps();
                }

                if (localDirty && HasToken)
                {
                    yield return SyncLocalApps();
                }

                TrackForeground();

                if (round % flushEvery == 0 && usage.PendingCount > 0)
                {
                    yield return FlushUsage();
                }

                yield return Heartbeat();

                // 连着两轮没连上后台：别再干等老师去推地址，自己扫一遍网段找后台
                MaybeFindBackend();

                round += 1;
                yield return new WaitForSeconds(LauncherConfig.HeartbeatSeconds);
            }
        }

        IEnumerator Enroll()
        {
            SetStatus("正在向后台登记设备…");
            EnrollResponse result = null;
            var error = "";
            yield return ApiClient.Enroll((response) => result = response, (message) => error = message);

            if (result != null && !string.IsNullOrEmpty(result.token))
            {
                pairingCode = result.pairingCode ?? "";
                Online = true;
                FailedRounds = 0;
                LastError = "";
                SetStatus(string.IsNullOrEmpty(pairingCode) ? "已连接后台" : "已连接后台｜配对码 " + pairingCode);
                Note("登记成功：设备 #" + result.deviceId + (string.IsNullOrEmpty(pairingCode) ? "" : "，配对码 " + pairingCode));
                if (result.student != null && result.student.id > 0)
                {
                    Note("已绑定学生：" + result.student.name);
                }
            }
            else
            {
                Online = false;
                FailedRounds += 1;
                LastError = string.IsNullOrEmpty(error) ? "登记失败" : error;
                SetStatus("连不上后台：" + LastError);
            }

            Notify();
        }

        public IEnumerator RefreshManifest()
        {
            if (refreshing)
            {
                yield break;
            }

            refreshing = true;
            ManifestResponse result = null;
            var error = "";
            yield return ApiClient.GetManifest((response) => result = response, (message) => error = message);
            refreshing = false;

            // 只要后台正常应答就算成功，清单是空的也算：老师在网页上把应用都停掉、
            // 或者这台还没扫出应用时，后台回的是 200 + 空数组。
            // 以前这里额外要求 apps.Length > 0，把这种应答当成「连不上后台」，
            // 于是学生端写着「连不上后台」，网页上这台却明明在线，而且失败次数攒两回就开始满网段找后台。
            if (result != null && result.apps != null)
            {
                var wasLocked = IsLocked;
                var previousLessonId = screenLessonId;
                manifest = result;
                manifestRev = result.rev;
                Online = true;
                FailedRounds = 0;
                LastError = "";
                SetStatus(AppCount == 0
                    ? OnlineLabel() + "｜后台还没安排能跑的应用"
                    : OnlineLabel() + "｜共 " + AppCount + " 个应用，可运行 " + CountAllowed() + " 个");

                if (IsLocked && !wasLocked)
                {
                    Note("老师锁定了这台头显：" + LockReason);
                    usage.SealRunning();
                    simulatedAppKey = "";
                    AndroidApps.BackToHome();
                }

                AnnounceLesson(previousLessonId);
            }
            else
            {
                Online = false;
                FailedRounds += 1;
                LastError = string.IsNullOrEmpty(error) ? "拉取清单失败" : error;
                SetStatus(manifest == null ? "连不上后台：" + LastError : "沿用上次策略（" + LastError + "）");
            }

            Notify();
        }

        IEnumerator Heartbeat()
        {
            HeartbeatResponse result = null;
            var error = "";
            yield return ApiClient.Heartbeat(ForegroundPackage, (response) => result = response, (message) => error = message);

            if (result != null && result.ok)
            {
                Online = true;
                FailedRounds = 0;
                LastError = "";
                if (result.commands != null && result.commands.Length > 0)
                {
                    yield return HandleCommands(result.commands);
                }

                // 老师刚在网页上动过手（放开应用、点名、下课、锁定）：立刻重拉清单，
                // 不用等下一次定时轮询。老后台不回 rev（＝0）时按「没变」处理，行为跟以前一样。
                if (result.rev > 0 && manifestRev >= 0 && result.rev != manifestRev)
                {
                    Note("后台的安排变了（第 " + manifestRev + " → 第 " + result.rev + " 版），重新拉一份清单");
                    yield return RefreshManifest();
                }
            }
            else
            {
                Online = false;
                FailedRounds += 1;
                LastError = string.IsNullOrEmpty(error) ? "心跳失败" : error;
            }

            Notify();
        }

        IEnumerator FlushUsage()
        {
            var batch = usage.TakeBatch();
            if (batch == null)
            {
                yield break;
            }

            UsageResponse result = null;
            var error = "";
            yield return ApiClient.PostUsage(batch, (response) => result = response, (message) => error = message);

            if (result != null && result.ok)
            {
                var extra = result.duplicates > 0 ? "（重复 " + result.duplicates + " 条已忽略）" : "";
                Note("上报时长 " + result.accepted + " 条" + extra);
            }
            else
            {
                usage.Rollback(batch);
                LastError = string.IsNullOrEmpty(error) ? "时长上报失败" : error;
            }

            Notify();
        }

        /// <summary>上课期间的画面回传：按后台要求的间隔抓一帧画面推上去，没上课就完全不动。</summary>
        IEnumerator ScreenLoop()
        {
            var endOfFrame = new WaitForEndOfFrame();

            while (true)
            {
                yield return endOfFrame;

                if (!ShouldCaptureScreen() || screenBusy == 1)
                {
                    continue;
                }

                var frame = ScreenStreamer.CaptureFrame(out var width, out var height, out var captureError);
                if (frame == null || frame.Length == 0)
                {
                    screenFailures += 1;
                    screenError = captureError;
                    nextScreenAt = Time.realtimeSinceStartup + Mathf.Max(3f, screenIntervalMs / 1000f * 4f);
                    continue;
                }

                var package = string.IsNullOrEmpty(ForegroundPackage) ? SelfPackageName : ForegroundPackage;
                nextScreenAt = Time.realtimeSinceStartup + Mathf.Max(0.4f, screenIntervalMs / 1000f);
                screenBusy = 1;
                yield return ApiClient.UploadScreen(frame, width, height, package, delegate(ScreenUploadResponse response)
                {
                    if (response == null)
                    {
                        return;
                    }

                    screenFrames += 1;
                    screenError = "";
                    lastScreenAt = DateTime.Now;
                    if (response.intervalMs > 0)
                    {
                        screenIntervalMs = Mathf.Clamp(response.intervalMs, 400, 60000);
                    }
                }, delegate(string message)
                {
                    screenFailures += 1;
                    screenError = message;
                });
                screenBusy = 0;
            }
        }

        bool ShouldCaptureScreen()
        {
            if (!HasToken || !Online)
            {
                return false;
            }

            if (!ScreenEnabled)
            {
                if (lastScreenAt != DateTime.MinValue)
                {
                    lastScreenAt = DateTime.MinValue;
                }

                return false;
            }

            return Time.realtimeSinceStartup >= nextScreenAt;
        }

        /// <summary>课堂状态一变（开课 / 下课 / 换人 / 改应用清单）就在启动器里说清楚，学生不用猜。</summary>
        void AnnounceLesson(int previousLessonId)
        {
            var lesson = Lesson;
            var currentId = lesson == null ? 0 : lesson.id;
            if (currentId == previousLessonId)
            {
                return;
            }

            screenLessonId = currentId;
            if (lesson == null)
            {
                Note("下课了，应用清单回到后台的默认设置");
                return;
            }

            screenIntervalMs = lesson.screen != null && lesson.screen.intervalMs > 0
                ? Mathf.Clamp(lesson.screen.intervalMs, 400, 60000)
                : screenIntervalMs;
            nextScreenAt = 0f;
            screenError = "";

            Note("上课了《" + LessonTitle + "》｜" + LessonClass + "｜" + LessonTeacher + "｜"
                + (LessonAppLimit > 0 ? "这节课只安排 " + LessonAppLimit + " 个应用" : "这节课应用不限")
                + "｜画面 " + (ScreenEnabled ? screenIntervalMs + " 毫秒回传一帧" : "不回传"));
            Note("这节课这台头显的使用者：" + LessonStudentName
                + (LessonHasStudent ? "（" + manifest.lesson.student.studentNo + "）" : "，等老师在网页上指定"));
        }

        IEnumerator HandleCommands(CommandInfo[] commands)
        {
            var ids = new List<int>();
            foreach (var command in commands)
            {
                if (command == null)
                {
                    continue;
                }

                ids.Add(command.id);
                Note("收到后台指令：" + DescribeCommand(command.type));

                switch (command.type)
                {
                    case "lock":
                        usage.SealRunning();
                        simulatedAppKey = "";
                        AndroidApps.BackToHome();
                        break;
                    case "unlock":
                    case "refresh":
                        yield return RefreshManifest();
                        break;
                    case "scan":
                        ScanLocalApps();
                        yield return SyncLocalApps();
                        break;
                    case "restart":
                        usage.SealRunning();
                        usage.Save();
                        LauncherConfig.DeviceToken = "";
                        manifest = null;
                        yield return Enroll();
                        yield return RefreshManifest();
                        break;
                    case "message":
                        ShowTeacherMessage(command.payload != null ? command.payload.text : "");
                        break;
                    default:
                        Note("这个指令端上还不支持：" + command.type);
                        break;
                }
            }

            yield return ApiClient.AckCommands(ids.ToArray());
        }

        // ---------- 前台应用与时长 ----------
        void TrackForeground()
        {
            var foreground = "";
            if (AndroidApps.IsAndroid)
            {
                foreground = AndroidApps.ForegroundPackage(Mathf.Max(90, LauncherConfig.HeartbeatSeconds * 3)) ?? "";
            }
            else if (!string.IsNullOrEmpty(simulatedAppKey))
            {
                foreground = PackageOfKey(simulatedAppKey);
            }

            ForegroundPackage = foreground;

            if (string.IsNullOrEmpty(foreground) || foreground == SelfPackageName)
            {
                usage.SealRunning();
                return;
            }

            var app = FindByPackage(foreground);
            if (app == null)
            {
                // 不在管理清单里：不计学习时长；白名单模式下还要把它拦回桌面
                HandleUnknownForeground(foreground);
                usage.SealRunning();
                return;
            }

            if (!app.allowed)
            {
                Note("已拦截 " + app.name + "：" + app.reason);
                usage.SealRunning();
                simulatedAppKey = "";
                AndroidApps.BackToHome();
                return;
            }

            usage.Begin(app.key, app.packageName);
        }

        /// <summary>点击应用卡片：返回 null 表示已启动，否则返回中文失败原因。</summary>
        public string LaunchApp(AppItem app)
        {
            if (app == null)
            {
                return "没有这个应用";
            }

            if (IsLocked)
            {
                Note("锁定中，点不动 " + app.name);
                return "设备当前锁定：" + LockReason;
            }

            if (!app.allowed)
            {
                var reason = string.IsNullOrEmpty(app.reason) ? "老师还没有开放这个应用" : app.reason;
                Note("已挡住 " + app.name + "：" + reason);
                return reason;
            }

            if (!AndroidApps.Launch(app.packageName))
            {
                var missing = "头显里没装《" + app.name + "》（" + app.packageName + "）";
                Note(missing);
                return missing;
            }

            usage.SealRunning();
            usage.Begin(app.key, app.packageName);
            simulatedAppKey = AndroidApps.IsAndroid ? "" : app.key;
            ForegroundPackage = app.packageName;
            Note("启动 " + app.name);
            Notify();
            return null;
        }

        /// <summary>从应用里回到启动器（真机上由返回按钮或系统返回触发；编辑器里用于结束模拟运行）。</summary>
        public void ReturnToLauncher()
        {
            if (string.IsNullOrEmpty(simulatedAppKey))
            {
                return;
            }

            var name = NameOfKey(simulatedAppKey);
            simulatedAppKey = "";
            ForegroundPackage = "";
            var sealedEvent = usage.SealRunning();
            if (sealedEvent != null)
            {
                Note(name + " 结束，本次 " + UsageRecorder.HumanSeconds(sealedEvent.seconds));
            }

            Notify();
        }

        public bool IsSimulated(AppItem app) => app != null && app.key == simulatedAppKey;

        // ---------- 本机应用：扫描 → 上报 → 白名单拦截 ----------
        /// <summary>读一遍本机装了哪些应用：真机问 PackageManager，编辑器里读本地清单文件。</summary>
        public void ScanLocalApps()
        {
            if (localApps == null)
            {
                localApps = new LocalAppScanner();
            }

            localApps.Scan(SelfPackageName);
            var vr = 0;
            foreach (var record in localApps.Apps)
            {
                if (record != null && record.isVr)
                {
                    vr += 1;
                }
            }

            localDirty = true;
            Note("扫描本机应用：" + localApps.Apps.Count + " 个可启动应用（VR " + vr + " 个）· "
                + (localApps.Simulated ? "PC 模拟清单" : "真机"));
            Notify();
        }

        /// <summary>把扫描结果整份交给后台，后台标出没装的、把新应用挂到「待确认」，然后立刻重新拉清单。</summary>
        public IEnumerator SyncLocalApps()
        {
            if (syncingApps || !HasToken || localApps == null || localApps.Apps.Count == 0)
            {
                yield break;
            }

            syncingApps = true;
            AppSyncResponse result = null;
            var error = "";
            yield return ApiClient.SyncApps(
                new List<LocalAppRecord>(localApps.Apps).ToArray(),
                (response) => result = response,
                (message) => error = message);
            syncingApps = false;

            if (result != null && result.ok)
            {
                Online = true;
                FailedRounds = 0;
                LastError = "";
                localDirty = false;
                var line = "本机应用已上报：" + result.scanned + " 个，清单里这台还缺 " + result.missingCount + " 个";
                if (result.discovered > 0)
                {
                    line += "；新发现 " + result.discovered + " 个，等老师在后台确认";
                }

                if (result.uninstalled > 0)
                {
                    line += "；" + result.uninstalled + " 个已卸载";
                }

                Note(line);
                yield return RefreshManifest();
            }
            else
            {
                Online = false;
                LastError = string.IsNullOrEmpty(error) ? "本机应用上报失败" : error;
                Note("本机应用上报失败：" + LastError);
            }

            Notify();
        }

        /// <summary>学生打开了管理清单外的应用：白名单模式下送回桌面并给后台留痕。</summary>
        void HandleUnknownForeground(string packageName, bool force = false)
        {
            var record = localApps == null ? null : localApps.Find(packageName);
            if (record == null || record.isSystem || record.isSelf || !StrictMode)
            {
                return;
            }

            if (packageName == unmanagedPackage)
            {
                unmanagedStreak += 1;
            }
            else
            {
                unmanagedPackage = packageName;
                unmanagedStreak = 1;
            }

            // 切应用的瞬间前台包名会乱跳，连着两轮都是同一个才动手，免得误伤
            if (unmanagedStreak < 2 && !force)
            {
                return;
            }

            var label = string.IsNullOrEmpty(record.label) ? packageName : record.label;
            ViolationCount += 1;
            unmanagedStreak = 0;
            simulatedAppKey = "";
            usage.SealRunning();
            AndroidApps.BackToHome();
            Note("拦下清单外的应用《" + label + "》（" + packageName + "），已送回桌面");
            if (HasToken)
            {
                StartCoroutine(ApiClient.ReportViolation(packageName, label, (error) => Note("越权记录没报上去：" + error)));
            }

            Notify();
        }

        /// <summary>PC 模拟：假装学生从桌面点开某个本机应用，返回拦截原因（null 表示放行）。</summary>
        public string SimulateForegroundApp(string packageName)
        {
            var app = FindByPackage(packageName);
            if (app != null)
            {
                return LaunchApp(app);
            }

            var record = localApps == null ? null : localApps.Find(packageName);
            var label = record == null || string.IsNullOrEmpty(record.label) ? packageName : record.label;
            if (!StrictMode)
            {
                Note("自由运行模式：《" + label + "》不在清单里也能跑，但不计入学习时长");
                Notify();
                return null;
            }

            HandleUnknownForeground(packageName, true);
            return "《" + label + "》不在允许清单里，已送回桌面";
        }

        /// <summary>本机应用在管理清单里的状态，给「本机应用」页显示。</summary>
        public string ManagedStateOf(LocalAppRecord record, out string reason)
        {
            reason = "";
            var app = record == null ? null : FindByPackage(record.packageName);
            if (app == null)
            {
                return record != null && record.isSystem ? "系统应用·不管控" : "清单外·会被拦回桌面";
            }

            reason = app.reason;
            return app.allowed ? "已纳管·允许运行" : "已纳管·老师已禁止";
        }

        /// <summary>自检用：往本机清单加一个后台没登记的应用，用来验证白名单拦截确实生效。</summary>
        public LocalAppRecord AddLocalProbeApp()
        {
            if (localApps == null)
            {
                ScanLocalApps();
            }

            var record = localApps.AddProbe();
            Note("已加入探针应用《" + record.label + "》（" + record.packageName + "）用于验证拦截");
            return record;
        }

        // ---------- 老师端/界面上要用的查询 ----------
        public AppItem FindById(int id)
        {
            foreach (var app in Apps)
            {
                if (app != null && app.id == id)
                {
                    return app;
                }
            }

            return null;
        }

        public AppItem FindByPackage(string packageName)
        {
            if (string.IsNullOrEmpty(packageName))
            {
                return null;
            }

            foreach (var app in Apps)
            {
                if (app != null && app.packageName == packageName)
                {
                    return app;
                }
            }

            return null;
        }

        string PackageOfKey(string key)
        {
            foreach (var app in Apps)
            {
                if (app != null && app.key == key)
                {
                    return app.packageName;
                }
            }

            return "";
        }

        string NameOfKey(string key)
        {
            foreach (var app in Apps)
            {
                if (app != null && app.key == key)
                {
                    return app.name;
                }
            }

            return key;
        }

        public int CountAllowed()
        {
            var count = 0;
            foreach (var app in Apps)
            {
                if (app != null && app.allowed)
                {
                    count += 1;
                }
            }

            return count;
        }

        public int UsedTodaySeconds()
        {
            var seconds = 0;
            foreach (var app in Apps)
            {
                if (app != null)
                {
                    seconds += app.usedMinutes * 60;
                }
            }

            var running = usage.Running;
            if (running != null)
            {
                seconds += Mathf.Max(0, Mathf.RoundToInt((DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - running.startedAt) / 1000f));
            }

            return seconds;
        }

        /// <summary>换后台地址：清掉旧 token，下一轮重新登记（机房换网不用重打包）。</summary>
        public void ApplyServerUrl(string url)
        {
            var cleaned = (url ?? "").Trim();
            if (string.IsNullOrEmpty(cleaned))
            {
                return;
            }

            LauncherConfig.ServerBaseUrl = cleaned;
            LauncherConfig.DeviceToken = "";
            manifest = null;
            pairingCode = "";
            Note("后台地址改为 " + LauncherConfig.ServerBaseUrl + "，重新登记");
            SetStatus("正在切换后台…");
            Notify();
        }

        /// <summary>
        /// 连不上后台时该不该自己去扫：连够两轮失败才扫（刚重启那几轮不必惊动整个网段），
        /// 越扫不到扫得越稀，60 秒起步、最多五分钟一轮，免得后台真关机时把机房网络敲满。
        /// </summary>
        void MaybeFindBackend()
        {
            if (Online || backends.IsRunning || FailedRounds < SearchAfterFailedRounds)
            {
                return;
            }

            if (Time.realtimeSinceStartup - lastSearchAt < searchCooldown)
            {
                return;
            }

            lastSearchAt = Time.realtimeSinceStartup;
            if (backends.Start())
            {
                Note("连着没连上后台，自己扫一遍 " + backends.Segment + " 找后台…");
                Notify();
            }
        }

        /// <summary>设置页「自动找后台」：马上扫一轮，不等失败攒够两轮。</summary>
        public bool SearchBackend()
        {
            if (backends.IsRunning)
            {
                return false;
            }

            searchCooldown = 60f;
            lastSearchAt = Time.realtimeSinceStartup;
            return backends.Start();
        }

        /// <summary>
        /// 扫描结论落地。三种情况都说清下一步：找到别的地址就直接换；
        /// 找到的就是现在这个，那问题不在地址而在路上（网段、路由器客户端隔离）；
        /// 一个没找到，多半是后台这台电脑没开、或者两头根本不在同一个网段。
        /// </summary>
        void HandleBackendSearch(BackendFinder.Outcome outcome)
        {
            if (!outcome.found)
            {
                searchCooldown = Mathf.Min(300f, searchCooldown * 2f);
                Note("扫了 " + backends.Segment + " 这一片共 " + outcome.candidates + " 个地址，没找到后台"
                    + (string.IsNullOrEmpty(outcome.error) ? "" : "：" + outcome.error)
                    + "｜" + Mathf.RoundToInt(searchCooldown) + " 秒后再扫一轮。先确认老师那台电脑上的后台在跑（bash scripts/dev.sh）");
                Notify();
                return;
            }

            searchCooldown = 60f;
            if (outcome.url == LauncherConfig.ServerBaseUrl)
            {
                Note("扫到了后台，就是现在用的这个 " + outcome.url
                    + "｜地址没错，那就是这台头显到它的路上被挡了：确认连的是同一个 Wi-Fi，路由器没开「客户端隔离」");
                Notify();
                return;
            }

            Note("自动找到了后台 " + outcome.url + "（原先指 " + LauncherConfig.ServerBaseUrl + "），换过去重新登记");
            ApplyServerUrl(outcome.url);
        }

        public void ReloadTokenAndRetry()
        {
            LauncherConfig.DeviceToken = "";
            manifest = null;
            Note("清除本机令牌，重新走登记流程");
            Notify();
        }

        string OnlineLabel() => Online ? "已连接 " + LauncherConfig.ServerBaseUrl : "离线（最后一次策略仍生效）";

        /// <summary>
        /// 接住老师从网页发来的那句话：原来这里是个空的 case，指令被 ack 掉、学生那边啥也没发生，
        /// 老师以为话送到了，其实压根没送到。
        /// </summary>
        /// <summary>接住老师那句话并让界面重画；无头自检也直接调它。</summary>
        public void ShowTeacherMessage(string text)
        {
            var clean = (text ?? "").Trim();
            if (string.IsNullOrEmpty(clean))
            {
                Note("后台发来一条没带话的提示，忽略");
                return;
            }

            teacherMessage = clean;
            teacherMessageUntil = Time.realtimeSinceStartupAsDouble + TeacherMessageSeconds;
            Note("老师带话：" + clean);
            Notify();
        }

        static string DescribeCommand(string type)
        {
            switch (type)
            {
                case "lock":
                    return "锁定设备";
                case "unlock":
                    return "解除锁定";
                case "restart":
                    return "重新登记";
                case "refresh":
                    return "刷新清单";
                case "scan":
                    return "重新扫描本机应用";
                case "message":
                    return "老师带话";
                default:
                    return type ?? "未知";
            }
        }

        void SetStatus(string text)
        {
            StatusText = text ?? "";
        }

        void Note(string text)
        {
            var line = DateTime.Now.ToString("HH:mm:ss") + "｜" + text;
            entries.Add(line);
            while (entries.Count > LogCapacity)
            {
                entries.RemoveAt(0);
            }

            ApiClient.Log("事件", text);
        }

        void Notify()
        {
            // 顺手刷新问话口的快照，老师随时敲 IP 问到的都是当前状态
            PublishIdentity();
            StateChanged?.Invoke();
        }
    }
}
