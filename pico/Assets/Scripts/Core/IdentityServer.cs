using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace VrLauncher.Core
{
    /// <summary>
    /// 「按 IP 找头显」用的本机小 HTTP 服务：老师那台电脑主动敲开这台头显的 8790，
    /// 问一句 GET /v1/identity，就知道「你是谁、装着什么」，不用先在后台手敲序列号。
    /// 问的那一方是后台（server/src/discovery.js），这边是答的那一方，字段一一对得上。
    ///
    /// HTTP 收在独立线程里跑，那个线程只读 Publish 出来的快照，绝不碰 Unity API；
    /// 快照由主线程刷新（电量、前台应用、本机应用清单都在主线程上变）。
    /// </summary>
    public sealed class IdentityServer : IDisposable
    {
        public const int DefaultPort = 8790;

        /// <summary>一次可对外应答的快照：建好之后不再改，HTTP 线程读它不用加锁。</summary>
        sealed class Snapshot
        {
            public string serial = "";
            public string name = "";
            public string model = "";
            public string launcherVersion = "";
            public string foregroundApp = "";
            public int battery = -1;
            public string appsJson = "[]";
            public int appCount;
            /// <summary>这台启动器当前在连的后台地址，以及连上没连上：老师收编完却看见离线，答案就在这儿。</summary>
            public string serverBaseUrl = "";
            public bool backendOnline;
            public string backendError = "";
        }

        readonly object gate = new object();
        HttpListener listener;
        Thread worker;
        volatile Snapshot current;
        volatile bool stopping;
        /// <summary>老师从网页推来的后台地址：HTTP 线程只收下，真正改配置、重连都交给主线程。</summary>
        string pendingBackend;

        public int Port { get; private set; } = DefaultPort;
        public bool IsRunning { get; private set; }
        /// <summary>实际绑上的范围。绑在回环口时外面那台电脑是敲不动的，排障时要看得见。</summary>
        public string Bound { get; private set; } = "";
        public string LastError { get; private set; } = "";
        public int Requests { get; private set; }

        /// <summary>这台在局域网里的地址：老师就是往网页里填它来认领这点头显的。</summary>
        public string Address { get; private set; } = "";

        public int PublishedApps
        {
            get
            {
                var shot = current;
                return shot == null ? 0 : shot.appCount;
            }
        }

        /// <summary>给「设置」页用的一行状态。</summary>
        public string StatusLine
        {
            get
            {
                if (!IsRunning)
                {
                    return "没开" + (string.IsNullOrEmpty(LastError) ? "" : "：" + LastError);
                }

            return "开着 · 网页里填 " + Address + ":" + Port + "（监听在" + Bound + "）· 已答 " + Requests
                + " 次｜清单里 " + PublishedApps + " 个应用";
            }
        }

        /// <summary>
        /// 开始监听。先试全网卡（机房那台电脑才敲得动），挨个退回，最后才只对自己。
        /// 开不开都不影响启动器主流程：这台答不了话，老师照旧可以手填序列号登记。
        /// </summary>
        public bool Start(int port = DefaultPort)
        {
            lock (gate)
            {
                if (IsRunning)
                {
                    return true;
                }

                foreach (var host in new[] { "+", "*", "0.0.0.0", "127.0.0.1" })
                {
                    var trial = new HttpListener();
                    trial.Prefixes.Add("http://" + host + ":" + port + "/");
                    try
                    {
                        trial.Start();
                        listener = trial;
                        Port = port;
                        Bound = host == "+" || host == "*" ? "全网卡" : host;
                        Address = LocalAddress();
                        IsRunning = true;
                        LastError = "";
                        stopping = false;
                        worker = new Thread(Loop) { IsBackground = true, Name = "VR-Identity" };
                        worker.Start();
                        ApiClient.Log("问话口", "已监听 http://" + host + ":" + port + "/v1/identity");
                        return true;
                    }
                    catch (Exception error)
                    {
                        trial.Close();
                        LastError = error.Message;
                    }
                }

                IsRunning = false;
                ApiClient.Log("问话口", "监听 " + port + " 失败：" + LastError + "（老师可以照旧手填序列号登记）");
                return false;
            }
        }

        public void Stop()
        {
            HttpListener old;
            lock (gate)
            {
                if (listener == null)
                {
                    return;
                }

                stopping = true;
                IsRunning = false;
                old = listener;
                listener = null;
            }

            try
            {
                old.Stop();
                old.Close();
            }
            catch (Exception)
            {
                // 关停时正好在应答请求会抛，线程是后台线程，不用管
            }
        }

        public void Dispose() => Stop();

        /// <summary>主线程刷新快照：把「这台是谁、装着什么」抄一份，HTTP 线程随后随便读。battery 传 -1 表示读不到电量。</summary>
        public void Publish(string serial, string name, string model, string launcherVersion,
            string foregroundApp, int battery, IReadOnlyList<LocalAppRecord> apps,
            string serverBaseUrl = "", bool backendOnline = false, string backendError = "")
        {
            var shot = new Snapshot
            {
                serial = serial ?? "",
                name = string.IsNullOrEmpty(name) ? serial ?? "" : name,
                model = string.IsNullOrEmpty(model) ? "PICO 头显" : model,
                launcherVersion = string.IsNullOrEmpty(launcherVersion) ? "0.1.0" : launcherVersion,
                foregroundApp = foregroundApp ?? "",
                battery = battery,
                appsJson = AppsJson(apps),
                appCount = CountApps(apps),
                serverBaseUrl = serverBaseUrl ?? "",
                backendOnline = backendOnline,
                backendError = backendError ?? "",
            };
            current = shot;
        }

        /// <summary>主线程取走老师推来的后台地址（取一次清一次，不会重复重连）。</summary>
        public string TakePendingBackend()
        {
            lock (gate)
            {
                var value = pendingBackend;
                pendingBackend = null;
                return value;
            }
        }

        void Loop()
        {
            while (!stopping)
            {
                HttpListenerContext context;
                try
                {
                    context = listener == null ? null : listener.GetContext();
                }
                catch (Exception)
                {
                    return;
                }

                if (context == null)
                {
                    return;
                }

                try
                {
                    Reply(context);
                }
                catch (Exception error)
                {
                    try
                    {
                        Write(context, 500, "{\"error\":" + Quote("应答失败：" + error.Message) + "}");
                    }
                    catch (Exception)
                    {
                        // 连接已经断了，不必再管
                    }
                }
            }
        }

        void Reply(HttpListenerContext context)
        {
            var path = (context.Request.Url == null ? "" : context.Request.Url.AbsolutePath).TrimEnd('/');
            if (context.Request.HttpMethod == "POST" && path == "/v1/config")
            {
                ApplyBackendConfig(context);
                return;
            }

            if (context.Request.HttpMethod != "GET" || (path != "/v1/identity" && path != "/"))
            {
                Write(context, 404, "{\"error\":" + Quote("这儿只有 GET /v1/identity 和 POST /v1/config（后台把地址推给这台头显用）") + "}");
                return;
            }

            var shot = current;
            if (shot == null || string.IsNullOrEmpty(shot.serial))
            {
                Write(context, 503, "{\"error\":" + Quote("启动器还没准备好") + "}");
                return;
            }

            Requests += 1;
            // 报它敲门用的那个地址：老师从哪个 IP 找到的就记哪个，比本机自己猜的准
            var answered = context.Request.LocalEndPoint == null
                ? LocalAddress()
                : context.Request.LocalEndPoint.Address.ToString();

            Write(context, 200, "{"
                + "\"serial\":" + Quote(shot.serial)
                + ",\"name\":" + Quote(shot.name)
                + ",\"model\":" + Quote(shot.model)
                + ",\"launcherVersion\":" + Quote(shot.launcherVersion)
                + ",\"battery\":" + (shot.battery < 0 ? "null" : shot.battery.ToString(CultureInfo.InvariantCulture))
                + ",\"foregroundApp\":" + Quote(shot.foregroundApp)
                + ",\"ip\":" + Quote(answered)
                + ",\"serverBaseUrl\":" + Quote(shot.serverBaseUrl)
                + ",\"backendOnline\":" + (shot.backendOnline ? "true" : "false")
                + ",\"backendError\":" + Quote(shot.backendError)
                + ",\"apps\":" + shot.appsJson
                + "}");
        }

        /// <summary>
        /// 老师从网页把后台地址推过来（POST /v1/config {"serverBaseUrl":"http://192.168.31.20:8787"}）。
        /// 打包时写的默认地址是占位的，不改就得戴着头显在「设置」里敲 IP；这里收下之后由主线程改配置并重新登记。
        /// </summary>
        void ApplyBackendConfig(HttpListenerContext context)
        {
            var shot = current;
            var previous = shot == null ? "" : shot.serverBaseUrl;
            string body;
            try
            {
                using (var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8))
                {
                    body = reader.ReadToEnd();
                }
            }
            catch (Exception error)
            {
                Write(context, 400, "{\"error\":" + Quote("读请求体失败：" + error.Message) + "}");
                return;
            }

            var url = JsonString(body, "serverBaseUrl");
            if (string.IsNullOrEmpty(url))
            {
                Write(context, 400, "{\"error\":" + Quote("没读到 serverBaseUrl，得是 {\"serverBaseUrl\":\"http://192.168.31.20:8787\"} 这样") + "}");
                return;
            }

            if (!IsHttpAddress(url))
            {
                Write(context, 400, "{\"error\":" + Quote("后台地址得是 http://机房电脑IP:8787 这样（带 http:// 和端口），这儿给的是「" + url + "」") + "}");
                return;
            }

            lock (gate)
            {
                pendingBackend = url.TrimEnd('/');
            }

            Requests += 1;
            ApiClient.Log("问话口", "老师推来后台地址 " + url + "（原来是 " + (string.IsNullOrEmpty(previous) ? "没填" : previous) + "），交给主线程重连");
            Write(context, 200, "{\"serverBaseUrl\":" + Quote(url.TrimEnd('/'))
                + ",\"applied\":true"
                + ",\"changed\":" + (url.TrimEnd('/') != (previous ?? "").TrimEnd('/') ? "true" : "false") + "}");
        }

        /// <summary>从一小段 JSON 里挖一个字符串字段：只认「"键":"值"」这种最普通的写法，够用就行。</summary>
        static string JsonString(string json, string key)
        {
            if (string.IsNullOrEmpty(json))
            {
                return "";
            }

            var probe = "\"" + key + "\"";
            var at = json.IndexOf(probe, StringComparison.Ordinal);
            if (at < 0)
            {
                return "";
            }

            // char 版 IndexOf 在这个运行时没有 StringComparison 重载，字符本身不需要区域设置比较
            var colon = json.IndexOf(':', at + probe.Length);
            var quote = colon < 0 ? -1 : json.IndexOf('"', colon + 1);
            if (quote < 0)
            {
                return "";
            }

            var builder = new StringBuilder();
            for (var i = quote + 1; i < json.Length; i += 1)
            {
                var ch = json[i];
                if (ch == '\\' && i + 1 < json.Length)
                {
                    builder.Append(json[i + 1]);
                    i += 1;
                    continue;
                }

                if (ch == '"')
                {
                    break;
                }

                builder.Append(ch);
            }

            return builder.ToString().Trim();
        }

        static bool IsHttpAddress(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri))
            {
                return false;
            }

            return (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps) && !string.IsNullOrEmpty(uri.Host);
        }

        static void Write(HttpListenerContext context, int status, string json)
        {
            var bytes = Encoding.UTF8.GetBytes(json);
            context.Response.StatusCode = status;
            context.Response.ContentType = "application/json; charset=utf-8";
            context.Response.ContentLength64 = bytes.Length;
            context.Response.Headers["Cache-Control"] = "no-store";
            context.Response.OutputStream.Write(bytes, 0, bytes.Length);
            context.Response.Close();
        }

        static string AppsJson(IReadOnlyList<LocalAppRecord> apps)
        {
            var builder = new StringBuilder("[");
            if (apps != null)
            {
                var first = true;
                for (var i = 0; i < apps.Count; i += 1)
                {
                    var record = apps[i];
                    if (record == null || string.IsNullOrEmpty(record.packageName))
                    {
                        continue;
                    }

                    if (!first)
                    {
                        builder.Append(',');
                    }

                    first = false;
                    builder.Append("{\"packageName\":").Append(Quote(record.packageName))
                        .Append(",\"label\":").Append(Quote(record.label))
                        .Append(",\"version\":").Append(Quote(record.version))
                        .Append(",\"isVr\":").Append(record.isVr ? "true" : "false")
                        .Append(",\"isSystem\":").Append(record.isSystem ? "true" : "false")
                        .Append('}');
                }
            }

            return builder.Append(']').ToString();
        }

        static int CountApps(IReadOnlyList<LocalAppRecord> apps)
        {
            if (apps == null)
            {
                return 0;
            }

            var count = 0;
            for (var i = 0; i < apps.Count; i += 1)
            {
                if (apps[i] != null && !string.IsNullOrEmpty(apps[i].packageName))
                {
                    count += 1;
                }
            }

            return count;
        }

        /// <summary>本机在局域网里的地址，取不到就退回回环，只用来兜底。</summary>
        static string LocalAddress()
        {
            try
            {
                foreach (var address in Dns.GetHostAddresses(Dns.GetHostName()))
                {
                    if (address.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(address))
                    {
                        return address.ToString();
                    }
                }
            }
            catch (Exception)
            {
                // 读不到不碍事
            }

            return "127.0.0.1";
        }

        /// <summary>自己拼 JSON，不用 JsonUtility：HTTP 线程上不碰 Unity 原生调用。</summary>
        static string Quote(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "\"\"";
            }

            var builder = new StringBuilder(value.Length + 8).Append('"');
            foreach (var ch in value)
            {
                switch (ch)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (ch < 32)
                        {
                            builder.Append("\\u").Append(((int) ch).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(ch);
                        }

                        break;
                }
            }

            return builder.Append('"').ToString();
        }
    }
}
