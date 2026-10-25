using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace VrLauncher.Core
{
    /// <summary>
    /// 和后台对话的唯一入口。全部协程调用，失败只回调错误文案，不抛异常打断启动器。
    /// </summary>
    public static class ApiClient
    {
        static string Url(string path) => LauncherConfig.ServerBaseUrl + "/api/v1" + path;

        static IEnumerator Send(string method, string path, string body, Action<string> onRaw, Action<string> onError)
        {
            using (var request = new UnityWebRequest(Url(path), method))
            {
                request.timeout = 12;
                request.downloadHandler = new DownloadHandlerBuffer();
                if (body != null)
                {
                    var bytes = Encoding.UTF8.GetBytes(body);
                    request.uploadHandler = new UploadHandlerRaw(bytes);
                    request.SetRequestHeader("Content-Type", "application/json");
                }

                if (!string.IsNullOrEmpty(LauncherConfig.DeviceToken))
                {
                    request.SetRequestHeader("X-Device-Token", LauncherConfig.DeviceToken);
                }

                // SendWebRequest 在明文 HTTP 被 Player Settings 挡下时是直接抛异常，
                // 不走失败回调。不接住的话整个启动器主循环协程就断了，
                // 之后一个请求都不会再发（心跳、清单、课堂状态全停）。
                var operation = SendSafely(request, method, path, onError);
                if (!operation.isOK)
                {
                    yield break;
                }

                yield return operation.handle;

#if UNITY_2020_1_OR_NEWER
                var failed = request.result != UnityWebRequest.Result.Success;
#else
                var failed = request.isNetworkError || request.isHttpError;
#endif
                var text = request.downloadHandler != null ? request.downloadHandler.text : "";
                if (failed)
                {
                    // 后台的 4xx 里带中文原因，优先展示
                    var message = text;
                    try
                    {
                        var parsed = JsonUtility.FromJson<ErrorPayload>(text);
                        if (parsed != null && !string.IsNullOrEmpty(parsed.error))
                        {
                            message = parsed.error;
                        }
                    }
                    catch (Exception)
                    {
                        // 不是 JSON 就用原文
                    }

                    // 连不上这类错（明文 HTTP 被系统挡下、域名解析不了、连接被拒）后台一个字都没回，
                    // 原因只在 request.error 里；不捞出来的话日志就剩一句冷冰冰的「失败：0 」
                    if (string.IsNullOrEmpty(message))
                    {
                        message = request.error;
                    }

                    Debug.LogWarning("[后台] " + method + " " + path + " 失败：" + request.responseCode + " " + message);
                    if (request.responseCode == 401 || request.responseCode == 403)
                    {
                        LauncherConfig.DeviceToken = "";
                    }

                    onError?.Invoke(string.IsNullOrEmpty(message) ? "连不上后台（" + request.responseCode + "）" : message);
                    yield break;
                }

                onRaw?.Invoke(text);
            }
        }

        [Serializable]
        class ErrorPayload
        {
            public string error;
        }

        /// <summary>
        /// 把 request.SendWebRequest() 可能抛的平台级拒绝接住，转成中文文案。
        /// 迭代器里不能把 yield 放进 try/catch，所以单独拆一个方法返回结果。
        /// </summary>
        static SendOutcome SendSafely(UnityWebRequest request, string method, string path, Action<string> onError)
        {
            try
            {
                return new SendOutcome { isOK = true, handle = request.SendWebRequest() };
            }
            catch (Exception error)
            {
                var reason = ExplainSendFailure(error);
                Debug.LogWarning("[后台] " + method + " " + path + " 没发出去：" + reason);
                onError?.Invoke(reason);
                return new SendOutcome { isOK = false };
            }
        }

        struct SendOutcome
        {
            public bool isOK;
            public UnityWebRequestAsyncOperation handle;
        }

        /// <summary>明文 HTTP 被禁是最常见的一种「请求根本没发出去」，直接告诉用户去哪儿改。</summary>
        static string ExplainSendFailure(Exception error)
        {
            var text = error == null ? "" : error.Message;
            if (text.IndexOf("Insecure", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "系统不让走明文 HTTP。改一下：Project 设置 → Other Settings → "
                    + "Allow downloads over HTTP 选 Always allowed（后台是 http://192.168.x.x 这种内网地址）";
            }

            return string.IsNullOrEmpty(text) ? "请求没发出去" : text;
        }

        public static void Log(string tag, string detail) => Debug.Log("[启动器·" + tag + "] " + detail);

        public static IEnumerator Enroll(Action<EnrollResponse> onDone, Action<string> onError = null)
        {
            var payload = JsonUtility.ToJson(new EnrollRequest
            {
                serial = LauncherConfig.DeviceSerial,
                name = LauncherConfig.DeviceName,
                model = LauncherConfig.DeviceModel,
                launcherVersion = LauncherConfig.AppVersion,
            });

            yield return Send("POST", "/devices/enroll", payload, (text) =>
            {
                var result = JsonUtility.FromJson<EnrollResponse>(text);
                if (result != null && !string.IsNullOrEmpty(result.token))
                {
                    LauncherConfig.DeviceToken = result.token;
                    Log("登记", "成功：设备 #" + result.deviceId + " 配对码 " + result.pairingCode);
                }

                onDone?.Invoke(result);
            }, onError);
        }

        public static IEnumerator GetManifest(Action<ManifestResponse> onDone, Action<string> onError = null)
        {
            yield return Send("GET", "/manifest", null, (text) =>
            {
                onDone?.Invoke(JsonUtility.FromJson<ManifestResponse>(text));
            }, onError);
        }

        public static IEnumerator Heartbeat(string foregroundApp, Action<HeartbeatResponse> onDone = null, Action<string> onError = null)
        {
            var body = JsonUtility.ToJson(new HeartbeatRequest
            {
                battery = Mathf.RoundToInt(Mathf.Clamp01(SystemInfo.batteryLevel) * 100),
                foregroundApp = foregroundApp ?? "",
                wifi = SystemInfo.processorType,
                launcherVersion = LauncherConfig.AppVersion,
            });

            yield return Send("POST", "/devices/heartbeat", body, (text) =>
            {
                onDone?.Invoke(JsonUtility.FromJson<HeartbeatResponse>(text));
            }, onError);
        }

        public static IEnumerator PostUsage(UsageBatch batch, Action<UsageResponse> onDone = null, Action<string> onError = null)
        {
            yield return Send("POST", "/usage/batch", JsonUtility.ToJson(batch), (text) =>
            {
                onDone?.Invoke(JsonUtility.FromJson<UsageResponse>(text));
            }, onError);
        }

        /// <summary>把头显扫到的本机应用清单整体上报给后台，后台会标出没装的、并把新应用挂到「待确认」。</summary>
        public static IEnumerator SyncApps(LocalAppRecord[] records, Action<AppSyncResponse> onDone = null, Action<string> onError = null)
        {
            var body = JsonUtility.ToJson(new AppSyncRequest
            {
                apps = records ?? Array.Empty<LocalAppRecord>(),
                scannedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            });

            yield return Send("POST", "/devices/apps/sync", body, (text) =>
            {
                var result = JsonUtility.FromJson<AppSyncResponse>(text);
                if (result != null && result.ok)
                {
                    Log("本机应用", "上报 " + result.scanned + " 个，新发现 " + result.discovered + " 个，已卸载 " + result.uninstalled + " 个");
                }

                onDone?.Invoke(result);
            }, onError);
        }

        /// <summary>白名单模式下学生打开了清单外的应用，回一条给后台留痕。</summary>
        public static IEnumerator ReportViolation(string packageName, string label, Action<string> onError = null)
        {
            var body = JsonUtility.ToJson(new ViolationRequest
            {
                packageName = packageName,
                label = label ?? "",
                action = "blocked",
            });

            yield return Send("POST", "/devices/violation", body, null, onError);
        }

        /// <summary>
        /// 推一帧头显画面给后台（body 直接是 PNG 二进制）。
        /// 设备身份靠 X-Device-Token，HTTP 头只允许 ASCII，所以 X-Frame-App 放包名而不是中文名。
        /// </summary>
        public static IEnumerator UploadScreen(byte[] jpeg, int width, int height, string foregroundApp,
            Action<ScreenUploadResponse> onDone = null, Action<string> onError = null)
        {
            if (jpeg == null || jpeg.Length == 0)
            {
                yield break;
            }

            using (var request = new UnityWebRequest(Url("/devices/screen"), "POST"))
            {
                request.timeout = 10;
                request.downloadHandler = new DownloadHandlerBuffer();
                request.uploadHandler = new UploadHandlerRaw(jpeg);
                request.SetRequestHeader("Content-Type", "image/png");
                request.SetRequestHeader("X-Frame-Width", Mathf.Max(1, width).ToString());
                request.SetRequestHeader("X-Frame-Height", Mathf.Max(1, height).ToString());
                request.SetRequestHeader("X-Frame-App", ToHeaderAscii(foregroundApp));
                if (!string.IsNullOrEmpty(LauncherConfig.DeviceToken))
                {
                    request.SetRequestHeader("X-Device-Token", LauncherConfig.DeviceToken);
                }

                var operation = SendSafely(request, "POST", "/devices/screen", onError);
                if (!operation.isOK)
                {
                    yield break;
                }

                yield return operation.handle;

#if UNITY_2020_1_OR_NEWER
                var failed = request.result != UnityWebRequest.Result.Success;
#else
                var failed = request.isNetworkError || request.isHttpError;
#endif
                var text = request.downloadHandler != null ? request.downloadHandler.text : "";
                if (failed)
                {
                    if (request.responseCode == 401 || request.responseCode == 403)
                    {
                        LauncherConfig.DeviceToken = "";
                    }

                    Debug.Log("[后台] 画面上传失败：" + request.responseCode + " " + text);
                    onError?.Invoke(string.IsNullOrEmpty(text) ? "画面没传上去（" + request.responseCode + "）" : text);
                    yield break;
                }

                ScreenUploadResponse parsed = null;
                try
                {
                    parsed = JsonUtility.FromJson<ScreenUploadResponse>(text);
                }
                catch (Exception)
                {
                    parsed = null;
                }

                onDone?.Invoke(parsed);
            }
        }

        /// <summary>HTTP 头不能带中文，非 ASCII 一律丢掉，否则 UnityWebRequest 直接抛异常。</summary>
        static string ToHeaderAscii(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "unknown";
            }

            var builder = new StringBuilder(value.Length);
            foreach (var character in value)
            {
                if (character >= 33 && character <= 126 && character != '"' && character != ';')
                {
                    builder.Append(character);
                }
            }

            return builder.Length == 0 ? "unknown" : builder.ToString();
        }

        public static IEnumerator AckCommands(int[] ids, Action<string> onError = null)
        {
            if (ids == null || ids.Length == 0)
            {
                yield break;
            }

            yield return Send("POST", "/commands/ack", JsonUtility.ToJson(new AckRequest { ids = ids }), null, onError);
        }
    }
}
