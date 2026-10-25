using System;
using UnityEngine;
using UnityEngine.UI;
using VrLauncher.Core;
using VrLauncher.Integration;

namespace VrLauncher.UI
{
    /// <summary>
    /// 首页刷新与「应用卡」：一卡一应用，状态、剩余时长、能不能点，全写在卡片上。
    /// 点卡片正文＝看详情卡；点卡片右下角的动作卡＝真的执行（进入 / 结束 / 为什么）。
    /// 首页只留三样东西：一句结论（横幅）、一排能跑的应用、四张页签，其余功能都在「设置」里。
    /// </summary>
    public partial class LauncherUI
    {
        // 老师带的话只弹一次提示条，别每秒重复弹
        string teacherLineSeen = "";

        void Rebuild()
        {
            if (mainLayer == null || bootstrap == null)
            {
                return;
            }

            RefreshLiveLines();
            RefreshTabs();
            RebuildCards();

            var locked = bootstrap.IsLocked;
            lockLayer.gameObject.SetActive(locked);
            if (locked)
            {
                lockReason.text = string.IsNullOrEmpty(bootstrap.LockReason) ? "老师已锁定这台头显" : bootstrap.LockReason;
                lockNote.text = bootstrap.StatusText;
            }

            if (page != Page.Home)
            {
                RebuildPage();
            }
        }

        void RefreshLiveLines()
        {
            appRunning = bootstrap.Usage != null && bootstrap.Usage.Running != null;

            statusValue.text = bootstrap.Online ? "已连后台" : "离线·照上次规矩跑";
            statusValue.color = bootstrap.Online ? Good : Warn;
            statusDot.color = bootstrap.Online ? Good : Warn;

            RefreshBanner();

            if (subtitleLine != null)
            {
                subtitleLine.text = bootstrap.InLesson ? bootstrap.LessonLine : WhoLine();
                subtitleLine.color = bootstrap.InLesson ? Sky : Muted;
            }

            if (bootstrap.TeacherMessageVisible && bootstrap.TeacherMessage != teacherLineSeen)
            {
                teacherLineSeen = bootstrap.TeacherMessage;
                Toast("老师带话：" + bootstrap.TeacherMessage, Amber);
            }
        }

        /// <summary>顶栏小字只讲"我是谁、这台是谁的"；上课了就换成老师那节课的横幅。</summary>
        string WhoLine()
        {
            if (!bootstrap.HasStudent)
            {
                // 学生早就不跟头显绑死了：现在是老师开一节课、当堂指定谁用哪台，
                // 这一句得指到「上课」那件事上，不然学生会一直等一个网页上根本没有的「绑一下」按钮
                return "现在没在课上 · 老师开课后在这台点你的名，就能开始跑了";
            }

            return "我是 " + bootstrap.StudentName + "（学号 " + bootstrap.StudentNo + "）｜这台头显：" + bootstrap.DeviceLabel;
        }

        /// <summary>
        /// 横幅是首页的"一句话结论"：现在能跑几个、是不是在上课、还是今天用完了。
        /// 底色就是状态色（蓝=正在跑、绿=时间宽裕、橙=快用完、粉=都跑不了、紫=还没清单），
        /// 学生不用读小字，看一眼颜色就知道现在是什么情况。
        /// </summary>
        void RefreshBanner()
        {
            var used = bootstrap.UsedTodaySeconds();
            var runnable = 0;
            var tightest = (AppItem)null;
            var blockedReason = "";
            foreach (var app in bootstrap.Apps)
            {
                if (app == null)
                {
                    continue;
                }

                if (StateOf(app) == "可运行" && bootstrap.IsInstalled(app))
                {
                    runnable += 1;
                    if (Capped(app) && app.remainingMinutes >= 0 && app.remainingMinutes <= 8
                        && (tightest == null || app.remainingMinutes < tightest.remainingMinutes))
                    {
                        tightest = app;
                    }
                }
                else if (string.IsNullOrEmpty(blockedReason))
                {
                    blockedReason = ReasonLine(app);
                }
            }

            Color tone;
            string glyph;
            string value;
            string note;

            if (appRunning)
            {
                tone = Sky;
                glyph = "跑";
                value = "正在跑《" + Compact(RunningName(), 12) + "》";
                note = "跑完回这一页点「结束」就行，这段时长会自动记到后台"
                    + (bootstrap.InLesson ? "｜" + bootstrap.ScreenShort : "｜今天已跑 " + Human(used));
            }
            else if (bootstrap.InLesson)
            {
                tone = runnable > 0 ? Good : Warn;
                glyph = "课";
                value = "上课中《" + Compact(bootstrap.LessonTitle, 12) + "》";
                note = bootstrap.LessonClass + "｜"
                    + (bootstrap.LessonHasStudent ? "这节课你在用这台" : "等老师在这节课里点名")
                    + "｜" + (bootstrap.LessonAppLimit > 0 ? "老师只开了 " + bootstrap.LessonAppLimit + " 个应用" : "应用不限")
                    + "｜现在能跑 " + runnable + " 个";
            }
            else if (bootstrap.AppCount == 0)
            {
                tone = Grape;
                // 连上了但一个应用都没安排 ≠ 连不上后台：前者不该让学生去翻后台地址
                glyph = bootstrap.HasManifest ? "空" : "等";
                value = bootstrap.HasManifest ? "后台还没安排能玩的应用" : "还在等后台给清单";
                note = bootstrap.HasManifest
                    ? "应用可能都被老师停掉了，等放开就行｜点右边「刷新清单」可以再要一次"
                    : "点右边的「刷新清单」再要一次；还是空的话，到「设置」里核对后台地址。";
            }
            else if (runnable == 0)
            {
                tone = Coral;
                glyph = "歇";
                value = "今天这些应用都跑不了";
                note = "今天已跑 " + Human(used) + "｜" + blockedReason + "｜点一张卡片能看到具体原因";
            }
            else
            {
                tone = tightest == null ? Good : Warn;
                glyph = "玩";
                value = "现在能跑 " + runnable + " 个应用";
                note = "一共 " + bootstrap.AppCount + " 个｜今天已跑 " + Human(used) + "｜"
                    + (tightest == null ? "时间还宽裕" : "《" + Compact(tightest.name, 8) + "》只剩 " + Mathf.Max(0, tightest.remainingMinutes) + " 分钟")
                    + "｜点一张卡片就能进";
            }

            ApplyTone(bannerBg, tone, 1f);
            bannerGlyph.text = glyph;
            bannerValue.text = value;
            // 老师刚带过话就直接占用这行小字：那会儿最该让学生看见的就是这句话
            var teacher = bootstrap.TeacherMessage;
            bannerNote.text = string.IsNullOrEmpty(teacher) ? note : "老师带话：" + teacher;
            bannerChip.text = WhoName();
        }

        string WhoName()
        {
            var name = bootstrap.InLesson ? bootstrap.LessonStudentName : bootstrap.StudentName;
            var bound = bootstrap.InLesson ? bootstrap.LessonHasStudent : bootstrap.HasStudent;
            if (bound)
            {
                return "我是 " + Compact(name, 7);
            }

            return bootstrap.InLesson ? "还没点你的名" : "没在课上";
        }

        /// <summary>横幅小字现在显示的那一句（无头自检验「老师带话」有没有真的打上屏）。</summary>
        public string BannerLine => bannerNote != null ? bannerNote.text : "";

        /// <summary>横幅那句大字标题（小字会被老师带话临时占用，标题不会）：自检拿它核对横幅走的是哪个分支。</summary>
        public string BannerTitle => bannerValue != null ? bannerValue.text : "";

        /// <summary>这张卡片跑不了时说人话：优先用后台给的原因，其次说没装。</summary>
        string ReasonLine(AppItem app)
        {
            if (!string.IsNullOrEmpty(app.reason))
            {
                return app.reason;
            }

            return bootstrap.IsInstalled(app) ? "老师在后台没开放《" + Compact(app.name, 8) + "》" : "这台头显还没装《" + Compact(app.name, 8) + "》";
        }

        /// <summary>一层层往回退：详情卡开着先关详情卡，在子页先回应用列表，已经在首页就不动。</summary>
        void GoBack()
        {
            if (dialogLayer != null && dialogLayer.gameObject.activeSelf)
            {
                CloseDialog();
                return;
            }

            if (page == Page.Local)
            {
                OpenPage(Page.Settings);
                return;
            }

            if (page != Page.Home)
            {
                OpenPage(Page.Home);
            }
        }

        void RefreshTabs()
        {
            foreach (var tab in tabs)
            {
                if (tab == null || tab.Card == null)
                {
                    continue;
                }

                // 本机应用是设置页里的子页，没有自己的页签，进来时高亮「设置」
                var current = tab.Page == page || (page == Page.Local && tab.Page == Page.Settings);
                var tone = TabTone(tab.Page);
                tab.Card.Pinned = current;
                if (tab.Title != null)
                {
                    tab.Title.color = current ? Tint(Ink, tone, 0.42f) : Ink;
                }

                if (tab.Note != null)
                {
                    tab.Note.text = TabNote(tab.Page);
                    tab.Note.color = current ? Tint(Muted, tone, 0.5f) : Muted;
                }
            }
        }

        string TabNote(Page target)
        {
            switch (target)
            {
                case Page.Usage:
                    return "今天跑了 " + Human(bootstrap.UsedTodaySeconds());
                case Page.Local:
                    return "本机 " + bootstrap.LocalApps.Count + " 个";
                case Page.Settings:
                    return bootstrap.Online ? "后台、权限、日志" : "离线·改地址在这";
                case Page.Home:
                default:
                    return bootstrap.CountAllowed() + " 个能跑 / 共 " + bootstrap.AppCount + " 个";
            }
        }

        void RebuildCards()
        {
            Clear(cardHost);
            var apps = bootstrap.Apps;
            if (apps.Length == 0)
            {
                emptyLine = AddText(cardHost, "空", bootstrap.HasManifest
                    ? "后台这会儿没安排能玩的应用：可能都被老师停掉了。\n等老师放开就好，也可以点上面横幅右边的「刷新清单」立刻再要一次。"
                    : "还没拉到应用清单。\n点上面横幅右边的「刷新清单」再要一次，或者到「设置」里核对后台地址。", 24f, Muted);
                Place(emptyLine.rectTransform, 40f, 40f, 1000f, 90f);
            }

            foreach (var app in apps)
            {
                if (app != null)
                {
                    BuildAppCard(app);
                }
            }

            LayoutRebuilder.ForceRebuildLayoutImmediate(cardHost);
        }

        /// <summary>
        /// 应用卡（592×168）：分类色大图标块 + 名字 + 一条时长进度 + 状态胶囊 + 一个大动作卡。
        /// 颜色比字先被看见：图标块 = 分类色，胶囊 = 当前状态色，动作卡在"能进"时才涂满饱和色。
        /// </summary>
        void BuildAppCard(AppItem app)
        {
            var running = bootstrap.IsSimulated(app);
            var installed = bootstrap.IsInstalled(app);
            var state = StateOf(app);
            var blocked = state != "可运行" || !installed;
            var tone = AppTone(app, running, installed, state);
            var mark = blocked ? Muted : CategoryColor(app.category);

            UiCard card;
            var rect = AddCardBase(cardHost, "卡_" + app.key,
                blocked ? CardBlocked : Tint(Card, mark, 0.14f),
                blocked ? CardBlockedHover : Tint(CardHover, mark, 0.24f),
                tone, delegate
                {
                    OnCardClicked(app);
                }, out card);

            var badge = AddImage(rect, "徽标", new Color(mark.r, mark.g, mark.b, blocked ? 0.26f : 1f), 26).rectTransform;
            Place(badge, 26f, 36f, 96f, 96f);
            var glyph = AddText(badge, "徽标字", BadgeText(app), 40f, blocked ? mark : InkDark);
            Stretch(glyph.rectTransform);
            glyph.alignment = TextAnchor.MiddleCenter;
            glyph.fontStyle = FontStyle.Bold;

            var name = AddText(rect, "名称", app.name, 30f, blocked ? Muted : Ink);
            Place(name.rectTransform, 142f, 20f, 260f, 40f);
            name.fontStyle = FontStyle.Bold;

            var meta = AddText(rect, "信息", app.category + "｜" + InstallStateLine(app), 16f, Muted);
            Place(meta.rectTransform, 144f, 64f, 260f, 22f);

            var ratio = Capped(app) ? Mathf.Clamp01(app.usedMinutes / (float) app.dailyMinutes) : 0f;
            var track = AddImage(rect, "进度槽", new Color(0f, 0f, 0f, 0.34f), 5).rectTransform;
            Place(track, 144f, 98f, 260f, 10f);
            var fill = AddImage(track, "进度", ratio > 0.9f ? Warn : tone, 5).rectTransform;
            Place(fill, 0f, 0f, ratio <= 0f ? 0f : Mathf.Max(10f, 260f * ratio), 10f);

            var caption = AddText(rect, "额度", MeterLine(app, state), 16f, blocked ? tone : Muted);
            Place(caption.rectTransform, 144f, 116f, 260f, 26f);

            var pill = AddImage(rect, "状态胶囊", new Color(tone.r, tone.g, tone.b, blocked ? 0.82f : 1f), 19).rectTransform;
            PlaceRight(pill, 24f, 22f, 150f, 38f);
            var status = AddText(pill, "状态", ShortStatus(app, running, installed, state), 18f, InkDark);
            Stretch(status.rectTransform);
            status.alignment = TextAnchor.MiddleCenter;
            status.fontStyle = FontStyle.Bold;

            var action = AddCardButton(rect, "动作", ActionLabel(app, running, installed, state),
                blocked ? Tint(PanelHi, tone, 0.24f) : tone, CardHover, tone, delegate
                {
                    OnActionClicked(app, running, installed, state);
                });
            PlaceRight(action, 24f, 80f, 150f, 56f);
            if (!blocked)
            {
                action.Find("文字").GetComponent<Text>().color = InkDark;
            }
        }

        void OnCardClicked(AppItem app)
        {
            var state = StateOf(app);
            if (state == "可运行" && bootstrap.IsInstalled(app) && !bootstrap.IsSimulated(app))
            {
                OnActionClicked(app, false, true, state);
                return;
            }

            OpenAppDetail(app);
        }

        void OnActionClicked(AppItem app, bool running, bool installed, string state)
        {
            if (running)
            {
                bootstrap.ReturnToLauncher();
                Toast("已结束《" + app.name + "》，这段时长已经记上", Warn);
                return;
            }

            if (!installed)
            {
                OpenAppDetail(app);
                Toast("这台头显没装《" + app.name + "》，装了才能点", Bad);
                return;
            }

            if (state != "可运行")
            {
                OpenAppDetail(app);
                return;
            }

            var error = bootstrap.LaunchApp(app);
            Toast(string.IsNullOrEmpty(error) ? "已进入《" + app.name + "》" + (AndroidApps.IsAndroid ? "" : "（编辑器里模拟跑，计时照常累计）") : "打不开：" + error,
                string.IsNullOrEmpty(error) ? Good : Bad);
        }

        static string ActionLabel(AppItem app, bool running, bool installed, string state)
        {
            if (running)
            {
                return "结束";
            }

            if (!installed)
            {
                return "详情";
            }

            return state == "可运行" ? "进入" : "为什么";
        }

        /// <summary>后台只对设了每日上限的应用算剩余时长；没设上限时下发的是 0，别当成用尽。</summary>
        static bool Capped(AppItem app)
        {
            return app != null && app.dailyMinutes > 0;
        }

        static bool OutOfTime(AppItem app)
        {
            return Capped(app) && app.remainingMinutes <= 0;
        }

        static bool NearlyOut(AppItem app)
        {
            return Capped(app) && app.remainingMinutes >= 0 && app.remainingMinutes <= 5;
        }

        /// <summary>剩余分钟；没设每日上限返回 -1，界面上显示「不限时长」。</summary>
        static int Remaining(AppItem app)
        {
            return Capped(app) ? app.remainingMinutes : -1;
        }

        /// <summary>把后台给的 allowed/reason 归成四种状态之一，卡片按状态配色和文案。</summary>
        static string StateOf(AppItem app)
        {
            if (app.allowed)
            {
                return OutOfTime(app) ? "时长超额" : "可运行";
            }

            var reason = app.reason ?? "";
            if (reason.Contains("时段"))
            {
                return "时段外";
            }

            return reason.Contains("用完") || reason.Contains("超额") || reason.Contains("上限") ? "时长超额" : "已挡住";
        }

        /// <summary>胶囊上的短状态，说的是学生听得懂的话，不是后台字段名。</summary>
        string ShortStatus(AppItem app, bool running, bool installed, string state)
        {
            if (running)
            {
                return "正在跑";
            }

            if (!installed)
            {
                return "没装";
            }

            if (state != "可运行")
            {
                switch (state)
                {
                    case "时长超额":
                        return "今天用完啦";
                    case "时段外":
                        return "不在时段";
                    default:
                        return "老师没开";
                }
            }

            return NearlyOut(app) ? "只剩 " + Mathf.Max(0, app.remainingMinutes) + " 分" : "能跑";
        }

        string MeterLine(AppItem app, string state)
        {
            if (state != "可运行")
            {
                return ReasonLine(app);
            }

            var used = "今天跑了 " + app.usedMinutes + " 分钟";
            if (!Capped(app))
            {
                return used + "｜时间不限";
            }

            return used + "｜还能跑 " + Mathf.Max(0, app.remainingMinutes) + " 分钟";
        }

        static string InstallStateLine(AppItem app)
        {
            switch (app.installState)
            {
                case "missing":
                    return "这台没装";
                case "installed":
                    return "这台已装";
                default:
                    return "没扫到";
            }
        }

        Color AppTone(AppItem app, bool running, bool installed, string state)
        {
            if (running)
            {
                return Accent;
            }

            if (!installed)
            {
                return Bad;
            }

            if (state == "可运行")
            {
                return NearlyOut(app) ? Warn : Good;
            }

            return state == "时段外" || state == "时长超额" ? Warn : Muted;
        }

        string BadgeText(AppItem app)
        {
            if (!string.IsNullOrEmpty(app.icon) && ChineseFont.HasGlyph(font, app.icon))
            {
                return app.icon;
            }

            return string.IsNullOrEmpty(app.name) ? "V" : app.name.Substring(0, 1);
        }

        static Color CategoryColor(string category)
        {
            Color color;
            return category != null && CategoryColors.TryGetValue(category, out color) ? color : Accent;
        }

        // ---------- 锁定卡 ----------
        void BuildLockLayer()
        {
            lockLayer = AddImage(root, "锁定层", new Color(0.02f, 0.03f, 0.05f, 0.94f)).rectTransform;
            Stretch(lockLayer);

            var card = AddPanelCard(lockLayer, "锁定卡", Bad);
            Center(card, 780f, 442f);

            var badge = AddImage(card, "徽标", new Color(Bad.r, Bad.g, Bad.b, 0.22f), 26).rectTransform;
            Place(badge, 342f, 28f, 96f, 96f);
            var glyph = AddText(badge, "徽标字", "锁", 40f, Bad);
            Stretch(glyph.rectTransform);
            glyph.alignment = TextAnchor.MiddleCenter;
            glyph.fontStyle = FontStyle.Bold;

            var title = AddText(card, "标题", "设备已被老师锁定", 34f, Ink);
            Place(title.rectTransform, 40f, 136f, 700f, 46f);
            title.alignment = TextAnchor.MiddleCenter;
            title.fontStyle = FontStyle.Bold;

            lockReason = AddText(card, "原因", "", 22f, Warn);
            Place(lockReason.rectTransform, 60f, 190f, 660f, 34f);
            lockReason.alignment = TextAnchor.MiddleCenter;

            lockNote = AddText(card, "状态", "", 16f, Muted);
            Place(lockNote.rectTransform, 60f, 226f, 660f, 26f);
            lockNote.alignment = TextAnchor.MiddleCenter;

            AddInfoCard(card, "怎么办", "怎么解开", "请老师在网页后台「PICO 设备」里点「解除锁定」", "解除后这块屏会自动回到应用列表", Accent,
                40f, 262f, 700f, 108f);

            var retry = AddCardButton(card, "重试卡", "问后台要最新状态", PanelHi, PanelHover, Accent, delegate
            {
                StartCoroutine(bootstrap.RefreshManifest());
                Toast("正在问后台能不能解锁…", Accent);
            });
            Place(retry, 290f, 382f, 200f, 48f);

            lockLayer.gameObject.SetActive(false);
        }
    }
}
