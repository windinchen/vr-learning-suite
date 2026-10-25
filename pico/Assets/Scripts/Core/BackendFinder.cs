using System;
using System.Collections.Generic;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace VrLauncher.Core
{
    /// <summary>
    /// 头显自己找后台。
    /// 原先只有两条路：打包时写死的占位地址、老师在网页上把地址推过来。
    /// 推的那条要求这台头显正醒着、启动器停在前台，头显一打盹或者换了网段就推不动，
    /// 于是出现「后台明明开着、头显一直说连不上这个后台」。这里补第三条：
    /// 读本机 IP → 顺着它所在的 C 段挨个敲 8787 的 /api/v1/hello → 谁答 product=vr-suite 就认谁。
    ///
    /// 扫描跑在独立线程上（socket 自己发一句裸 HTTP，不碰 Unity API，也不受 Unity 那套
    /// UnityWebRequest 只能在主线程起的限制），
    /// 结论由主线程用 TakeFinished 取一次，改配置、重连都留在主线程做。
    /// </summary>
    public sealed class BackendFinder
    {
        public const int DefaultPort = 8787;

        /// <summary>和后台 server/src/api.js 里的 BACKEND_PRODUCT 对得上：认暗号不认端口，免得把别的服务当后台。</summary>
        const string Marker = "vr-suite";

        // 一个 C 段 254 个地址。绝大多数地址根本不存在，连它只能干等到超时，所以扫描时间
        // 约等于「地址数 ÷ 并发 × 连接超时」：并发 64 路、连接只等 350 毫秒，两块网卡 508 个地址
        // 也三秒内扫完（真头显一般就一块网卡，一秒多）。连上之后读回话给到 700 毫秒，
        // 省电模式刚醒的那一次请求常被拖到一秒多，这点余量是留给它的。
        const int Concurrency = 64;
        const int ConnectTimeoutMs = 350;
        const int ReadTimeoutMs = 700;

        /// <summary>一次扫描的结论，只发一次。</summary>
        public sealed class Outcome
        {
            public bool found;
            public string url = "";
            public string segment = "";
            public int scanned;
            public int candidates;
            public string error = "";
        }

        volatile bool running;
        volatile bool finished;
        volatile string foundUrl = "";
        string segment = "";
        string lastError = "";
        string finishedAt = "";
        int scanned;
        int candidates;
        bool handed;

        public bool IsRunning => running;

        /// <summary>这次在扫哪几段，例如 192.168.31；报错和日志里都要用得上。</summary>
        public string Segment => string.IsNullOrEmpty(segment) ? "本机网段" : segment;

        /// <summary>设置页里给老师看的一行：扫过没有、找到没有、什么时候扫的。</summary>
        public string StatusLine
        {
            get
            {
                if (running)
                {
                    return "正在扫 " + Segment + " 这一片找后台（试到 " + scanned + "/" + candidates + "）…";
                }

                if (!finished)
                {
                    return "还没扫过：连着连不上后台时会自动扫，点「自动找后台」马上扫一次";
                }

                if (!string.IsNullOrEmpty(foundUrl))
                {
                    return "上次自动找（" + finishedAt + "）：找到后台 " + foundUrl + "｜试了 " + candidates + " 个地址";
                }

                return "上次自动找（" + finishedAt + "）：没找到后台，试了 " + candidates + " 个地址"
                    + (string.IsNullOrEmpty(lastError) ? "" : "｜" + lastError);
            }
        }

        /// <summary>开始一轮扫描。已经开始或扫不动（读不到本机 IP）返回 false。</summary>
        public bool Start(int port = DefaultPort)
        {
            if (running)
            {
                return false;
            }

            var segments = LocalSegments();
            if (segments.Count == 0)
            {
                lastError = "读不到这台头显的局域网 IP（Wi-Fi 没连？）";
                finished = true;
                handed = false;
                finishedAt = DateTime.Now.ToString("HH:mm:ss");
                return false;
            }

            var hosts = BuildHosts(segments);
            segment = string.Join(" / ", segments.ToArray());
            foundUrl = "";
            lastError = "";
            scanned = 0;
            candidates = hosts.Count;
            finished = false;
            handed = false;
            running = true;

            var cursor = 0;
            var active = Math.Min(Concurrency, hosts.Count);
            // 线程一启动就开始递减 active，循环上界必须另存一份，否则线程起不齐、收尾也数不对
            var total = active;
            for (var i = 0; i < total; i += 1)
            {
                var worker = new Thread(delegate()
                {
                    try
                    {
                        while (true)
                        {
                            var take = Interlocked.Increment(ref cursor) - 1;
                            if (take >= hosts.Count)
                            {
                                break;
                            }

                            var hit = Probe(hosts[take], port);
                            Interlocked.Increment(ref scanned);
                            if (!string.IsNullOrEmpty(hit) && string.IsNullOrEmpty(foundUrl))
                            {
                                foundUrl = hit;
                            }
                        }
                    }
                    finally
                    {
                        if (Interlocked.Decrement(ref active) == 0)
                        {
                            finishedAt = DateTime.Now.ToString("HH:mm:ss");
                            running = false;
                            finished = true;
                        }
                    }
                });
                worker.IsBackground = true;
                worker.Start();
            }

            return true;
        }

        /// <summary>扫完了取走结论；还在扫、或者已经取过，返回 null。</summary>
        public Outcome TakeFinished()
        {
            if (!finished || handed)
            {
                return null;
            }

            handed = true;
            return new Outcome
            {
                found = !string.IsNullOrEmpty(foundUrl),
                url = foundUrl ?? "",
                segment = segment ?? "",
                scanned = scanned,
                candidates = candidates,
                error = lastError ?? "",
            };
        }

        /// <summary>
        /// 敲一个地址要身份：是后台就返回它的地址，不是（没人听、连上不理、答非所问）返回空。
        /// 这里故意不用 HttpWebRequest —— 那个类名在 Unity 项目和 UnityEngine.Networking 撞名，
        /// 编译报的是「UnityEngine.Networking 里没有 HttpWebRequest」，看得人一头雾水；
        /// 扫 254 个地址要的也不多：连上、发一行 GET、读回开头几百字节，够了。
        /// </summary>
        static string Probe(string host, int port)
        {
            var startedAt = Environment.TickCount;
            try
            {
                using (var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
                {
                    socket.LingerState = new LingerOption(true, 0);

                    var connecting = socket.BeginConnect(host, port, null, null);
                    var left = ConnectTimeoutMs - (Environment.TickCount - startedAt);
                    if (left <= 0 || !connecting.AsyncWaitHandle.WaitOne(left, true))
                    {
                        return null;
                    }

                    socket.EndConnect(connecting);
                    socket.Send(Encoding.ASCII.GetBytes("GET /api/v1/hello HTTP/1.1\r\nHost: " + host + ":" + port
                        + "\r\nUser-Agent: vr-launcher/" + LauncherConfig.AppVersion
                        + "\r\nAccept: application/json\r\nConnection: close\r\n\r\n"));

                    var buffer = new byte[2048];
                    var text = "";
                    while (Environment.TickCount - startedAt < ReadTimeoutMs)
                    {
                        var budget = ReadTimeoutMs - (Environment.TickCount - startedAt);
                        if (budget <= 0)
                        {
                            break;
                        }

                        socket.ReceiveTimeout = budget;
                        var read = socket.Receive(buffer, buffer.Length, SocketFlags.None);
                        if (read <= 0)
                        {
                            break;
                        }

                        text += Encoding.ASCII.GetString(buffer, 0, read);
                        // 后台这一句很短，只要凑齐了头和一个 { 就不用再等它关连接
                        if (text.IndexOf("\r\n\r\n", StringComparison.Ordinal) >= 0 && text.IndexOf('{') >= 0)
                        {
                            break;
                        }
                    }

                    if (!text.StartsWith("HTTP/1.1 200", StringComparison.Ordinal)
                        && !text.StartsWith("HTTP/1.0 200", StringComparison.Ordinal))
                    {
                        return null;
                    }

                    if (Field(text, "product") != Marker)
                    {
                        return null;
                    }

                    // 后台自己报的地址最不容易拼错；它报不出来才退回刚敲的这个
                    var url = Field(text, "baseUrl");
                    return string.IsNullOrEmpty(url) ? "http://" + host + ":" + port : url.TrimEnd('/');
                }
            }
            catch (Exception)
            {
                // 没人听、连上不理、答的不是后台，对扫描来说是一回事：这个地址不是后台，换下一个
                return null;
            }
        }

        /// <summary>从一个 JSON 字符串里抠一个字符串字段。扫描线程里不敢用 JsonUtility，手写够用。</summary>
        static string Field(string json, string name)
        {
            if (string.IsNullOrEmpty(json))
            {
                return "";
            }

            var match = Regex.Match(json, "\"" + name + "\"\\s*:\\s*\"([^\"]*)\"");
            return match.Success ? match.Groups[1].Value : "";
        }

        /// <summary>这台头显连在哪几个局域网段上（有线、Wi-Fi 同时连着就都算）。</summary>
        static List<string> LocalSegments()
        {
            var segments = new List<string>();
            try
            {
                foreach (var card in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (card == null || card.OperationalStatus != OperationalStatus.Up)
                    {
                        continue;
                    }

                    if (card.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                    {
                        continue;
                    }

                    foreach (var address in card.GetIPProperties().UnicastAddresses)
                    {
                        var ip = address.Address;
                        if (ip.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(ip))
                        {
                            continue;
                        }

                        var parts = ip.GetAddressBytes();
                        // 只扫内网：169.254 是拿到 DHCP 之前自己凑的地址，公网段更不值得挨个敲
                        if (parts[0] != 10 && parts[0] != 172 && parts[0] != 192)
                        {
                            continue;
                        }

                        var prefix = parts[0] + "." + parts[1] + "." + parts[2];
                        if (!segments.Contains(prefix))
                        {
                            segments.Add(prefix);
                        }
                    }
                }
            }
            catch (Exception error)
            {
                ApiClient.Log("找后台", "读本机网卡失败：" + error.Message);
            }

            return segments;
        }

        /// <summary>把网段摊成待敲的地址。网关摆最前面：机房里老师的电脑常挂在 .1 上，先撞到能省两秒。</summary>
        static List<string> BuildHosts(List<string> segments)
        {
            var hosts = new List<string>();
            foreach (var prefix in segments)
            {
                hosts.Add(prefix + ".1");
                for (var i = 2; i <= 254; i += 1)
                {
                    hosts.Add(prefix + "." + i);
                }
            }

            return hosts;
        }
    }
}
