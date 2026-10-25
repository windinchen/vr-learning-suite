using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace VrLauncher.Core
{
    /// <summary>
    /// 时长账本：谁在什么时候跑了哪个应用、跑了多久。断网时先落盘，联网后按批上报（后台按 batchId 去重）。
    /// </summary>
    public class UsageRecorder
    {
        /// <summary>待上报队列上限：断网断久了也不许把文件无限撑大，撑不下就丢最老的。</summary>
        const int PendingCap = 2000;
        /// <summary>一段使用记录最长算 2 小时：启动器被杀掉时那段没法精确结算，宁可少算也别算出一整天。</summary>
        const int MaxSealedSeconds = 2 * 60 * 60;

        readonly string filePath;
        readonly List<UsageEvent> pending = new List<UsageEvent>();
        UsageEvent running;
        int batchSeq;

        public UsageRecorder()
        {
            filePath = Path.Combine(Application.persistentDataPath, "usage_queue.json");
            Load();
        }

        public int PendingCount => pending.Count + (running != null ? 1 : 0);
        public UsageEvent Running => running;

        /// <summary>开始计时某个应用（重复调用同一应用会沿用最早的起点）。</summary>
        public void Begin(string appKey, string packageName)
        {
            if (running != null && running.appKey == appKey)
            {
                return;
            }

            SealRunning();
            running = new UsageEvent
            {
                appKey = appKey,
                packageName = packageName,
                startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            ApiClient.Log("时长", "开始计时 " + (appKey ?? packageName));
        }

        /// <summary>结束当前计时，把这段时长放进待上报队列。</summary>
        public UsageEvent SealRunning()
        {
            if (running == null)
            {
                return null;
            }

            var ended = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            running.endedAt = ended;
            running.seconds = Mathf.Max(1, Mathf.RoundToInt((ended - running.startedAt) / 1000f));
            pending.Add(running);
            running = null;
            Trim();
            Save();
            return pending[pending.Count - 1];
        }

        /// <summary>取出一批待发上报数据；上报失败时调用 <see cref="Rollback"/> 放回去。</summary>
        public UsageBatch TakeBatch(int max = 60)
        {
            if (pending.Count == 0)
            {
                return null;
            }

            var take = new List<UsageEvent>();
            var count = Mathf.Min(max, pending.Count);
            for (var i = 0; i < count; i += 1)
            {
                take.Add(pending[i]);
            }

            pending.RemoveRange(0, count);
            batchSeq += 1;
            return new UsageBatch
            {
                batchId = "d" + LauncherConfig.DeviceSerial + "-t" + DateTimeOffset.UtcNow.ToUnixTimeSeconds() + "-s" + batchSeq,
                events = take.ToArray(),
            };
        }

        public void Rollback(UsageBatch batch)
        {
            if (batch == null || batch.events == null)
            {
                return;
            }

            pending.InsertRange(0, batch.events);
            Trim();
            Save();
        }

        void Trim()
        {
            if (pending.Count <= PendingCap)
            {
                return;
            }

            var dropped = pending.Count - PendingCap;
            pending.RemoveRange(0, dropped);
            ApiClient.Log("时长", "待上报队列满了，丢掉最老的 " + dropped + " 条（断网太久了）");
        }

        public void Save()
        {
            try
            {
                var file = new UsageQueueFile
                {
                    events = running != null ? AppendRunning() : pending.ToArray(),
                };
                File.WriteAllText(filePath, JsonUtility.ToJson(file));
            }
            catch (Exception error)
            {
                Debug.LogWarning("[时长] 写盘失败：" + error.Message);
            }
        }

        UsageEvent[] AppendRunning()
        {
            var all = new List<UsageEvent>(pending) { running };
            return all.ToArray();
        }

        /// <summary>把秒数说成人话，界面和日志共用。</summary>
        public static string HumanSeconds(int seconds)
        {
            if (seconds < 60)
            {
                return seconds + " 秒";
            }

            var minutes = seconds / 60;
            if (minutes < 60)
            {
                var rest = seconds % 60;
                return rest == 0 ? minutes + " 分钟" : minutes + " 分 " + rest + " 秒";
            }

            return minutes / 60 + " 小时 " + minutes % 60 + " 分钟";
        }

        void Load()
        {
            try
            {
                if (!File.Exists(filePath))
                {
                    return;
                }

                var file = JsonUtility.FromJson<UsageQueueFile>(File.ReadAllText(filePath));
                if (file?.events != null)
                {
                    // 上次退出时正在计时的哪一段没有结尾（endedAt＝0）：启动器是被划掉/崩溃/重启才没结算的，
                    // 现在补一段封顶 2 小时的账，否则这条要么以 0 秒报上去，要么整段丢掉。
                    var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var repaired = 0;
                    foreach (var item in file.events)
                    {
                        if (item == null || item.startedAt <= 0)
                        {
                            continue;
                        }

                        if (item.endedAt <= 0)
                        {
                            item.endedAt = nowMs;
                            item.seconds = Mathf.Clamp(Mathf.RoundToInt((nowMs - item.startedAt) / 1000f), 1, MaxSealedSeconds);
                            repaired += 1;
                        }

                        pending.Add(item);
                    }

                    Trim();
                    if (repaired > 0)
                    {
                        ApiClient.Log("时长", "补算了 " + repaired + " 段没结算的时长（上次退出时还在计时）");
                    }

                    ApiClient.Log("时长", "恢复未上报记录 " + pending.Count + " 条");
                }
            }
            catch (Exception error)
            {
                Debug.LogWarning("[时长] 读盘失败，忽略本地队列：" + error.Message);
            }
        }
    }
}
