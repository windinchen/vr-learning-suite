using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

namespace VrLauncher.EditorTools
{
    /// <summary>
    /// 命令行/自动化入口：不开编辑器界面也能把工程跑到「播放中」并抓图，方便脚本验证效果。
    /// 抓图走主相机离屏渲染，不依赖窗口有没有在前台。
    /// 注意：进播放模式会触发域重载，静态字段会被清空，所以「要不要抓图」必须存在 SessionState 里。
    /// </summary>
    public static class Automation
    {
        const string ScenePath = "Assets/Scenes/Launcher.unity";
        const string KeyArmed = "vr_launcher_capture_armed";
        const string KeyFolder = "vr_launcher_capture_folder";
        const string KeyPrefix = "vr_launcher_capture_prefix";
        const int Width = 1600;
        const int Height = 1000;

        static readonly Stopwatch Timer = new Stopwatch();
        static string outputFolder;
        static string prefix = string.Empty;
        static int stage;

        [InitializeOnLoadMethod]
        static void ArmAfterDomainReload()
        {
            if (SessionState.GetBool(KeyVerify, false))
            {
                EditorApplication.playModeStateChanged -= OnVerifyPlayMode;
                EditorApplication.playModeStateChanged += OnVerifyPlayMode;
                EditorApplication.update -= VerifyStep;
                EditorApplication.update += VerifyStep;
                Debug.Log("[验证] 域重载后重新挂上自检回调");
            }

            if (!SessionState.GetBool(KeyArmed, false))
            {
                return;
            }

            outputFolder = SessionState.GetString(KeyFolder, string.Empty);
            prefix = SessionState.GetString(KeyPrefix, string.Empty);
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            Debug.Log("[自动化] 域重载后重新就位，等播放模式起来后抓图");
        }

        /// <summary>普通打开：进播放模式后编辑器保持开着，可以用鼠标点。</summary>
        public static void EnterPlayMode()
        {
            Debug.Log("[自动化] 准备打开场景并进入播放模式");
            EditorApplication.delayCall += () =>
            {
                if (!EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single).IsValid())
                {
                    Debug.LogError("[自动化] 场景打开失败：" + ScenePath + "，请先跑「VR 启动器/① 生成场景」");
                    return;
                }

                EditorApplication.isPlaying = true;
            };
        }

        /// <summary>抓图模式：进播放模式后依次抓主界面 / 运行中 / 时长明细 / 设置 / 本机应用 / 应用详情卡，然后退出。</summary>
        public static void CaptureScreens()
        {
            var folder = Environment.GetEnvironmentVariable("VRLAUNCHER_SHOT_DIR");
            if (string.IsNullOrEmpty(folder))
            {
                folder = Path.Combine(Path.GetFullPath(".."), "Build/Screenshots");
            }

            Directory.CreateDirectory(folder);
            outputFolder = folder;
            prefix = Environment.GetEnvironmentVariable("VRLAUNCHER_SHOT_PREFIX") ?? string.Empty;
            SessionState.SetBool(KeyArmed, true);
            SessionState.SetString(KeyFolder, folder);
            SessionState.SetString(KeyPrefix, prefix);
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            Debug.Log("[自动化] 抓图模式已就位，输出目录 " + folder);
            EnterPlayMode();
        }

        static void OnPlayModeChanged(PlayModeStateChange change)
        {
            if (change != PlayModeStateChange.EnteredPlayMode || !SessionState.GetBool(KeyArmed, false))
            {
                return;
            }

            stage = 0;
            Timer.Restart();

            // 离屏抓帧的画幅要等于 RenderTexture 的画幅：界面是按相机 aspect 铺满视野的，
            // 相机的比例还停在 Game 视图上，出来的图就会比实际视野小一圈、四周留黑边。
            var view = Object.FindObjectOfType<Camera>();
            if (view != null)
            {
                view.aspect = (float) Width / Height;
            }

            EditorApplication.update += Step;
            Debug.Log("[自动化] 已进入播放模式，开始抓图流程");
        }

        static void Step()
        {
            var seconds = Timer.Elapsed.TotalSeconds;
            if (seconds < 9d + stage * 4d)
            {
                return;
            }

            var ui = Object.FindObjectOfType<VrLauncher.UI.LauncherUI>();
            if (ui == null)
            {
                Debug.LogWarning("[自动化] 场景里没找到 LauncherUI");
                return;
            }

            var locked = VrLauncher.Core.LauncherBootstrap.Instance != null
                && VrLauncher.Core.LauncherBootstrap.Instance.IsLocked;

            var name = locked && stage > 0 ? null : ShotName(stage);
            if (name == null)
            {
                Finish();
                return;
            }

            switch (stage)
            {
                case 0:
                    ui.ShowMainPanel();
                    break;
                case 1:
                    Debug.Log("[自动化] 模拟点击第一个可运行应用：" + ui.LaunchFirstAllowedApp());
                    break;
                case 2:
                    ui.ShowUsagePanel();
                    break;
                case 3:
                    ui.ShowSettingsPanel();
                    break;
                case 4:
                    ui.ShowLocalPanel();
                    break;
                case 5:
                    ui.ShowAppDetailPanel();
                    break;
            }

            ui.RefreshNow();
            Shoot(name);
            stage += 1;
        }

        static string ShotName(int index)
        {
            switch (index)
            {
                case 0: return prefix + "01-主界面";
                case 1: return prefix + "02-点击进入运行中";
                case 2: return prefix + "03-今日时长明细";
                case 3: return prefix + "04-设置与日志";
                case 4: return prefix + "05-本机应用";
                case 5: return prefix + "06-应用详情卡";
                default: return null;
            }
        }

        static void Finish()
        {
            EditorApplication.update -= Step;
            SessionState.SetBool(KeyArmed, false);
            Debug.Log("[自动化] 抓图完成，共 " + stage + " 张，输出目录 " + outputFolder);
            EditorApplication.Exit(0);
        }

        static void Shoot(string name)
        {
            var camera = Camera.main;
            if (camera == null)
            {
                Debug.LogError("[自动化] 没有带 MainCamera 标签的相机，无法抓图");
                return;
            }

            var rt = new RenderTexture(Width, Height, 24, RenderTextureFormat.ARGB32);
            if (!rt.Create())
            {
                Debug.LogError("[自动化] RenderTexture 创建失败");
                return;
            }

            var previousTarget = camera.targetTexture;
            var previousActive = RenderTexture.active;
            var texture = new Texture2D(Width, Height, TextureFormat.RGBA32, false);
            try
            {
                camera.targetTexture = rt;
                camera.Render();
                RenderTexture.active = rt;
                texture.ReadPixels(new Rect(0f, 0f, Width, Height), 0, 0);
                texture.Apply();

                var path = Path.Combine(outputFolder, name + ".png");
                File.WriteAllBytes(path, texture.EncodeToPNG());
                Debug.Log("[自动化] 已保存截图：" + path);
            }
            catch (Exception error)
            {
                Debug.LogError("[自动化] 抓图失败：" + error.Message);
            }
            finally
            {
                camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                Object.DestroyImmediate(texture);
                rt.Release();
                Object.DestroyImmediate(rt);
            }
        }

        // ---------- 无头自检：不靠显示器，也能验证「读本机应用 → 上报 → 拦截」整条链路 ----------
        const string KeyVerify = "vr_launcher_verify_armed";
        static double verifyStart = -1d;
        static int verifyStage;
        static int verifyFailures;

        /// <summary>进播放模式跑一遍本机应用链路，逐条打日志，最后按成败退出（0 通过 / 1 失败）。</summary>
        public static void VerifyRuntime()
        {
            SessionState.SetBool(KeyVerify, true);
            verifyStage = 0;
            verifyFailures = 0;
            verifyStart = -1d;
            EditorApplication.playModeStateChanged -= OnVerifyPlayMode;
            EditorApplication.playModeStateChanged += OnVerifyPlayMode;
            EditorApplication.update -= VerifyStep;
            EditorApplication.update += VerifyStep;
            Debug.Log("[验证] 准备进播放模式（无头自检）");
            EditorApplication.delayCall += delegate
            {
                EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
                EditorApplication.isPlaying = true;
            };
        }

        static void OnVerifyPlayMode(PlayModeStateChange change) => Debug.Log("[验证] 播放模式状态：" + change);

        static void Say(string line) => Debug.Log(line);

        static void Check(bool ok, string line)
        {
            Say((ok ? "[验证] ✅ " : "[验证] ❌ ") + line);
            if (!ok)
            {
                verifyFailures += 1;
            }
        }

        static void ExitVerify(int code)
        {
            EditorApplication.update -= VerifyStep;
            SessionState.SetBool(KeyVerify, false);
            Say("[验证] 结果：" + (code == 0 ? "通过" : "失败（" + code + " 项不对）"));
            EditorApplication.Exit(code == 0 ? 0 : 1);
        }

        static void VerifyStep()
        {
            if (!EditorApplication.isPlaying)
            {
                return;
            }

            if (verifyStart < 0d)
            {
                verifyStart = EditorApplication.timeSinceStartup;
            }

            var elapsed = EditorApplication.timeSinceStartup - verifyStart;
            // 最后两步（把后台应用清空 → 回头看端上有没有把它当成断线）要等到第 8、9 拍，
            // 每拍隔 12 秒，总时长顶到 120 秒以上，超时线得跟着往后挪
            if (elapsed > 175d)
            {
                Say("[验证] 超时没跑完");
                ExitVerify(1);
                return;
            }

            // 每步隔 12 秒。播放模式刚进去那几秒 Unity 还在导资源，第一个请求可能要十几秒才回，
            // 间隔给到 8 秒时会把「还没来得及登记」当成「登记不上」，清单和课堂两条断言跟着一起红
            if (elapsed < 12d + verifyStage * 12d)
            {
                return;
            }

            var bootstrap = VrLauncher.Core.LauncherBootstrap.Instance;
            if (bootstrap == null)
            {
                if (elapsed > 45d)
                {
                    Say("[验证] 启动器单例没起来");
                    ExitVerify(1);
                }

                return;
            }

            switch (verifyStage)
            {
                case 0:
                    VerifyScan(bootstrap);
                    break;
                case 1:
                    VerifyManifest(bootstrap);
                    break;
                case 2:
                    VerifyUi(bootstrap);
                    break;
                case 3:
                    VerifyIntercept(bootstrap);
                    break;
                case 4:
                    VerifyIdentity(bootstrap);
                    break;
                case 5:
                    VerifyBackendSearch(bootstrap);
                    break;
                case 6:
                    VerifyBackendFound(bootstrap);
                    break;
                case 7:
                    VerifyTeacherMessage(bootstrap);
                    break;
                case 8:
                    VerifyEmptyKick(bootstrap);
                    break;
                case 9:
                    VerifyEmptyAssert(bootstrap);
                    break;
                default:
                    ExitVerify(verifyFailures);
                    return;
            }

            verifyStage += 1;
        }

        /// <summary>
        /// 按 IP 找头显这条链路：后台是问的那一方，这里就地当一回后台，敲本机 8790 问一句，
        /// 看答回来的序列号、应用清单对不对（跟 server/src/discovery.js 问的是同一个口）。
        /// </summary>
        static void VerifyIdentity(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            Say("[验证] 问话口：" + bootstrap.IdentityLine);
            var port = VrLauncher.Core.IdentityServer.DefaultPort;
            var body = Ask("http://127.0.0.1:" + port + "/v1/identity");
            Check(body.Contains("\"serial\":\"" + bootstrap.Serial + "\""),
                "敲本机 " + port + " 问一句，答的序列号就是这台：" + bootstrap.Serial);
            var apps = body.Split(new[] { "\"packageName\":" }, StringSplitOptions.None).Length - 1;
            Check(apps > 0, "答复里带着装着哪些应用：" + apps + " 个");
            Say("[验证]    · 答复原文（截断）" + (body.Length > 420 ? body.Substring(0, 420) + "…" : body));
            Check(!Ask("http://127.0.0.1:" + port + "/v1/nothing").Contains("packageName"),
                "乱敲一个别的路径不会把清单漏出去");
        }

        /// <summary>
        /// 「自动找后台」：真扫一轮本网段。这一步故意放在最后——它可能顺手把后台地址改掉，
        /// 放在中间会把前面几步的断言带偏。
        /// </summary>
        static void VerifyBackendSearch(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            Say("[验证] 后台地址：" + bootstrap.ServerUrl + "｜" + bootstrap.BackendSearchLine);
            Check(bootstrap.SearchBackend(), "起一轮「自动找后台」扫描（真敲本网段 254 个地址的 8787）");
        }

        /// <summary>
        /// 扫描的收尾：扫得完（线程没被哪个地址吊住）、结论回得到主线程，
        /// 并且扫到的那个地址真答 vr-suite，不是撞上了 8787 上的别的服务。
        /// </summary>
        static void VerifyBackendFound(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            var line = bootstrap.BackendSearchLine;
            Check(!line.StartsWith("正在扫"), "这一趟扫描扫得完，不会把线程吊住：" + line);
            Check(!line.StartsWith("还没扫过"), "扫描结论回到了主线程：" + line);

            var mark = line.IndexOf("找到后台 ", StringComparison.Ordinal);
            if (mark < 0)
            {
                Say("[验证]    · 这一片没扫到别的后台（在电脑上模拟时常见：默认地址是 127.0.0.1，本来就不在要扫的网段里）");
                return;
            }

            var url = line.Substring(mark + "找到后台 ".Length).Split('｜')[0].Trim();
            Say("[验证]    · 扫到的后台：" + url + "｜换完之后这台在用：" + bootstrap.ServerUrl);
            Check(Ask(url + "/api/v1/hello").Contains("vr-suite"),
                "扫到的地址确实答 vr-suite，不是把 8787 上的别的服务当成了后台");
        }

        /// <summary>同步问一句本地 HTTP，拿不到就当失败，把原因带回去写进自检。</summary>
        static string Ask(string url)
        {
            try
            {
                var request = System.Net.WebRequest.Create(url);
                request.Timeout = 4000;
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (Exception error)
            {
                var reason = (error.InnerException ?? error).Message.Replace("\"", "'");
                return "{\"error\":\"" + reason + "\"}";
            }
        }

        static void VerifyScan(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            Say("[验证] 本机 = " + bootstrap.Serial + "｜" + bootstrap.StatusText);
            bootstrap.ScanLocalApps();
            Check(bootstrap.LocalApps.Count > 0, "读到本机应用 " + bootstrap.LocalApps.Count + " 个（" + bootstrap.LocalScanLine + "）");
            foreach (var record in bootstrap.LocalApps)
            {
                var reason = "";
                var state = bootstrap.ManagedStateOf(record, out reason);
                Say("[验证]    · " + record.label + "｜" + record.packageName + "｜v" + record.version
                    + (record.isVr ? "｜VR" : "｜系统") + "｜" + state + (string.IsNullOrEmpty(reason) ? "" : "（" + reason + "）"));
            }
        }

        static void VerifyManifest(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            Check(bootstrap.AppCount > 0, "后台清单 " + bootstrap.AppCount + " 个，可运行 " + bootstrap.CountAllowed() + " 个");
            // 版本号没传到的话，老师改完策略头显就只能等 30 秒的定时轮询，这条是那条链路的起点
            Check(bootstrap.ManifestRev > 0, "清单带后台改动版本号（第 " + bootstrap.ManifestRev
                + " 版），老师改完下次心跳（10 秒）就重拉");
            Say("[验证] 管控模式：" + bootstrap.AppMode + "（白名单=" + bootstrap.StrictMode + "）｜" + bootstrap.LocalScanLine);
            foreach (var app in bootstrap.Apps)
            {
                Say("[验证]    · " + app.name + "｜安装状态=" + (string.IsNullOrEmpty(app.installState) ? "-" : app.installState)
                    + "｜允许=" + app.allowed + "｜" + (string.IsNullOrEmpty(app.reason) ? "无原因" : app.reason));
            }

            Check(!string.IsNullOrEmpty(bootstrap.LocalScanLine) && bootstrap.LocalApps.Count > 0, "本机清单已同步给后台");
            VerifyLesson(bootstrap);
        }

        static void VerifyLesson(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            Check(bootstrap.Manifest != null && bootstrap.Manifest.lesson != null,
                "后台把课堂状态一起下发了（" + (bootstrap.InLesson ? "上课中" : "没在上课") + "）");
            Say("[验证] 课堂：" + (bootstrap.InLesson ? bootstrap.LessonLine : "这节课没开，应用清单按后台默认走")
                + "｜画面：" + bootstrap.ScreenLine);
            if (bootstrap.InLesson)
            {
                Check(!string.IsNullOrEmpty(bootstrap.LessonTitle), "课程名：" + bootstrap.LessonTitle
                    + "｜使用者：" + bootstrap.LessonStudentName + "｜" + bootstrap.LessonClass + "｜" + bootstrap.LessonTeacher);
                var blocked = 0;
                foreach (var app in bootstrap.Apps)
                {
                    if (app != null && !string.IsNullOrEmpty(app.reason) && app.reason.Contains("这节课没安排"))
                    {
                        blocked += 1;
                    }
                }

                Say("[验证]    · 因为是这节课的限定清单，" + blocked + " 个应用被课堂规则挡住");
            }

            var frame = VrLauncher.Core.ScreenStreamer.CaptureFrame(out var width, out var height, out var error);
            Check(frame != null ? frame.Length > 0 : !string.IsNullOrEmpty(error),
                frame != null && frame.Length > 0
                    ? "抓到画面一帧 " + width + "x" + height + "｜" + frame.Length + " 字节 PNG"
                    : "headless 下抓不到画面，已降级为原因：" + error);
        }

        static void VerifyUi(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            var ui = UnityEngine.Object.FindObjectOfType<VrLauncher.UI.LauncherUI>();
            Check(ui != null, "界面起来了");
            if (ui == null)
            {
                return;
            }

            ui.ShowLocalPanel();
            ui.RefreshNow();
            Check(ui.LocalRowCount > 0, "「本机应用」页列出 " + ui.LocalRowCount + " 行");
            Say("[验证] 模拟点第一个可运行应用：" + (ui.LaunchFirstAllowedApp() ?? "已启动"));
        }

        static void VerifyIntercept(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            var target = (VrLauncher.Core.LocalAppRecord)null;
            foreach (var record in bootstrap.LocalApps)
            {
                if (record != null && !record.isSystem && !record.isSelf && bootstrap.FindByPackage(record.packageName) == null)
                {
                    target = record;
                    break;
                }
            }

            if (target == null)
            {
                // 本机应用都被纳管了也不能跳过：临时塞一个后台没登记的应用，保证这一步每次都真的跑到
                target = bootstrap.AddLocalProbeApp();
                Say("[验证] 本机应用都在管理清单里，改用探针《" + target.label + "》测拦截");
            }

            var before = bootstrap.ViolationCount;
            var error = bootstrap.SimulateForegroundApp(target.packageName);
            Check(!string.IsNullOrEmpty(error), "打开清单外的《" + target.label + "》被拦下：" + error);
            Check(bootstrap.ViolationCount > before, "越权计数 +1（现在 " + bootstrap.ViolationCount + "）");
        }

        /// <summary>
        /// 老师「带句话」到端上这一环：后台那边 payload 已确认发得出来（api-test 有断言），
        /// 这里管的是端上接不接得住——字段名对不上、或者 case 是空的，话就静默丢了。
        /// </summary>
        static void VerifyTeacherMessage(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            var sample = JsonUtility.FromJson<VrLauncher.Core.CommandInfo>(
                "{\"id\":9,\"type\":\"message\",\"payload\":{\"text\":\"下课前三分钟收尾\"}}");
            Check(sample != null && sample.payload != null && sample.payload.text == "下课前三分钟收尾",
                "后台带话的字段名端上解析得到：" + (sample != null && sample.payload != null ? sample.payload.text : "没解析出来"));

            bootstrap.ShowTeacherMessage("第三组轮到你了，先去用滑雪");
            Check(bootstrap.TeacherMessageVisible && bootstrap.TeacherMessage == "第三组轮到你了，先去用滑雪",
                "老师带的话收到了：" + bootstrap.TeacherMessage);

            var ui = Object.FindObjectOfType<VrLauncher.UI.LauncherUI>();
            if (ui != null)
            {
                ui.RefreshNow();
                Check(ui.BannerLine.Contains("第三组轮到你了"), "这句话打上了首页横幅：" + ui.BannerLine);
            }
        }

        /// <summary>带设备令牌问后台一句（清单这类接口认 X-Device-Token）。</summary>
        static string AskAs(string url, string deviceToken)
        {
            try
            {
                var request = System.Net.WebRequest.Create(url);
                request.Timeout = 6000;
                if (!string.IsNullOrEmpty(deviceToken))
                {
                    request.Headers["X-Device-Token"] = deviceToken;
                }

                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (Exception error)
            {
                var reason = (error.InnerException ?? error).Message.Replace("\"", "'");
                return "{\"error\":\"" + reason + "\"}";
            }
        }

        /// <summary>问后台一个要写数据的接口（登录 / 删应用）。返回原文，让调用方自己看错在哪。</summary>
        static string AskWrite(string url, string method, string json, string token)
        {
            try
            {
                var request = System.Net.WebRequest.Create(url);
                request.Method = method;
                request.Timeout = 8000;
                request.ContentType = "application/json";
                if (!string.IsNullOrEmpty(token))
                {
                    request.Headers["Authorization"] = "Bearer " + token;
                }

                if (!string.IsNullOrEmpty(json))
                {
                    var bytes = Encoding.UTF8.GetBytes(json);
                    request.ContentLength = bytes.Length;
                    using (var stream = request.GetRequestStream())
                    {
                        stream.Write(bytes, 0, bytes.Length);
                    }
                }

                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (Exception error)
            {
                var reason = (error.InnerException ?? error).Message.Replace("\"", "'");
                return "{\"error\":\"" + reason + "\"}";
            }
        }

        /// <summary>从返回的 JSON 里抠一个字符串字段，够自检用就行，不引第三方解析。</summary>
        static string Pick(string json, string key)
        {
            var mark = "\"" + key + "\":\"";
            var at = json.IndexOf(mark, StringComparison.Ordinal);
            if (at < 0)
            {
                return "";
            }

            var start = at + mark.Length;
            var end = json.IndexOf('"', start);
            return end < 0 ? "" : json.Substring(start, end - start);
        }

        /// <summary>
        /// 倒数第二拍：把后台管理清单里的应用全删掉（后台回的是「200 + 空清单」），再让端上重拉一份。
        /// 这一步真改后台数据，所以整轮自检只有它排在最后，跑它之前那个库必须是临时库。
        /// </summary>
        static void VerifyEmptyKick(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            var login = AskWrite(bootstrap.ServerUrl + "/api/v1/auth/login", "POST",
                "{\"account\":\"admin\",\"password\":\"pico123456\"}", "");
            var token = Pick(login, "token");
            Check(!string.IsNullOrEmpty(token), "自检用老师身份登进后台，才删得掉应用" + (string.IsNullOrEmpty(token) ? "（" + login.Substring(0, Mathf.Min(120, login.Length)) + "）" : ""));
            if (string.IsNullOrEmpty(token))
            {
                return;
            }

            var manifest = JsonUtility.FromJson<VrLauncher.Core.ManifestResponse>(
                AskAs(bootstrap.ServerUrl + "/api/v1/manifest", VrLauncher.Core.LauncherConfig.DeviceToken));
            if (manifest == null || manifest.apps == null || manifest.apps.Length == 0)
            {
                Check(false, "删之前这台拿到的清单不该是空的：一个应用都没有，这一步就没法测「删空之后」");
                return;
            }

            var count = manifest.apps.Length;
            Check(count > 0, "删之前这台拿到的清单有 " + count + " 个应用");
            foreach (var app in manifest.apps)
            {
                if (app != null)
                {
                    AskWrite(bootstrap.ServerUrl + "/api/v1/apps/" + app.id, "DELETE", "{}", token);
                }
            }

            Say("[验证]    · 后台管理清单里那 " + count + " 个应用已全删掉，让端上重拉一份空的");
            bootstrap.StartCoroutine(bootstrap.RefreshManifest());
        }

        /// <summary>
        /// 收尾一拍：后台正常应答、清单是空的，端上得认它是「在线但没安排」，不能报「连不上后台」。
        /// 以前拉清单拿 apps.Length > 0 当成功条件，就是在这儿冤枉的：学生看到连不上，网页上这台明明在线。
        /// </summary>
        static void VerifyEmptyAssert(VrLauncher.Core.LauncherBootstrap bootstrap)
        {
            Say("[验证] 删空之后：" + bootstrap.StatusText);
            Check(bootstrap.HasManifest, "端上认这份空清单是后台的正常应答，不是「还没拿到清单」");
            Check(bootstrap.AppCount == 0, "清单确实空了（现在 " + bootstrap.AppCount + " 个）");
            Check(bootstrap.Online, "这台仍然算在线，网页上不会凭空多出一次「头显掉了」");
            Check(!bootstrap.StatusText.Contains("连不上后台"), "状态条不再冤枉成连不上后台：" + bootstrap.StatusText);

            var ui = Object.FindObjectOfType<VrLauncher.UI.LauncherUI>();
            if (ui != null)
            {
                ui.RefreshNow();
                // 看横幅标题走的是哪个分支：小字那行会被上一拍的「老师带话」临时占用，标题不会
                Check(ui.BannerTitle.Contains("还没安排"),
                    "横幅说「后台还没安排能玩的应用」，没让学生去翻后台地址：" + ui.BannerTitle);
            }
        }

        [MenuItem("VR 启动器/④ 进入播放模式（PC 模拟）")]
        public static void MenuEnterPlayMode()
        {
            EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
            EditorApplication.isPlaying = true;
        }

        [MenuItem("VR 启动器/⑤ 抓界面截图后退出")]
        public static void MenuCapture()
        {
            CaptureScreens();
        }
    }
}
