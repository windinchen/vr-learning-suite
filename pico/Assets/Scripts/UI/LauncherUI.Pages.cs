using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;
using VrLauncher.Core;
using VrLauncher.Integration;

namespace VrLauncher.UI
{
    /// <summary>
    /// 弹层页（我的时长 / 本机应用 / 设置）：一个壳三张页，内容一律是圆角卡片，
    /// 顶部三张统计卡，换页用的是全局那条常驻底部导航（弹层里不再自带页签），操作也是卡片按钮。
    /// 首页只管"选一个应用进去"，本机应用、后台地址、权限、日志这些功能性的东西都在这一层里。
    /// </summary>
    public partial class LauncherUI
    {
        void BuildPageLayer()
        {
            pageLayer = AddImage(root, "页面层", new Color(0f, 0f, 0f, 0.74f)).rectTransform;
            Stretch(pageLayer);

            var panel = AddImage(pageLayer, "面板", Panel, PanelRadius).rectTransform;
            Place(panel, PanelLeft, PanelTop, PanelWidth, PanelHeight);
            var bar = AddImage(panel, "色条", Accent, 5).rectTransform;
            PlaceBar(bar, 18f, 10f, 28f);

            pageTitle = AddText(panel, "标题", "", 30f, Ink);
            Place(pageTitle.rectTransform, 28f, 16f, 430f, 40f);
            pageTitle.fontStyle = FontStyle.Bold;

            pageSub = AddText(panel, "说明", "", 16f, Muted);
            Place(pageSub.rectTransform, 30f, 58f, 430f, 44f);

            // 返回目标跟着当前页走：本机应用是设置页的子页，返回应该回设置而不是直接跳首页
            var back = AddCardButton(panel, "返回卡", "回应用列表", Tint(PanelHi, Sky, 0.20f), PanelHover, Sky, delegate
            {
                OpenPage(page == Page.Local ? Page.Settings : Page.Home);
            });
            PlaceRight(back, 28f, 20f, 190f, 52f);
            pageBackText = back.Find("文字").GetComponent<Text>();

            pageActions = AddImage(panel, "操作区", Color.clear).rectTransform;
            PlaceRight(pageActions, 236f, 20f, 440f, 52f);
            var row = pageActions.gameObject.AddComponent<HorizontalLayoutGroup>();
            row.spacing = 12f;
            row.childAlignment = TextAnchor.MiddleRight;
            row.childControlWidth = false;
            row.childControlHeight = false;

            var statWidth = (PanelInner - 2 * 18f) / 3f;
            for (var i = 0; i < pageStats.Length; i += 1)
            {
                pageStats[i] = BuildStatCard(panel, "统计卡_" + i, 28f + i * (statWidth + 18f), PageStatTop, statWidth, PageStatHeight, "", Accent);
            }

            var viewport = AddImage(panel, "列表", new Color(0f, 0f, 0f, 0.16f), ChipRadius);
            Place(viewport.rectTransform, 28f, PageListTop, PanelInner, PageListHeight);
            viewport.rectTransform.gameObject.AddComponent<RectMask2D>();
            pageScroll = viewport.rectTransform.gameObject.AddComponent<ScrollRect>();
            pageScroll.horizontal = false;
            pageScroll.vertical = true;
            pageScroll.movementType = ScrollRect.MovementType.Elastic;
            pageScroll.scrollSensitivity = 34f;
            pageScrollViewport = viewport.rectTransform;

            pageHost = AddImage(viewport.rectTransform, "内容", Color.clear).rectTransform;
            Place(pageHost, 12f, 8f, PanelInner - 24f, 0f);
            pageScroll.viewport = viewport.rectTransform;
            pageScroll.content = pageHost;

            // 内容比列表高时给一个「下面还有」的小胶囊：戴着头显看不见底部就被划掉的卡片，
            // 会以为这一页只有这几张，滑一下这个动作没人教
            pageScrollHint = AddImage(viewport.rectTransform, "下滑提示", new Color(0f, 0f, 0f, 0.66f), ChipRadius).rectTransform;
            Place(pageScrollHint, (PanelInner - 260f) * 0.5f, PageListHeight - 46f, 260f, 36f);
            pageScrollHintText = AddText(pageScrollHint, "文字", "下面还有 · 往前推滑一下", 16f, Ink);
            Stretch(pageScrollHintText.rectTransform);
            pageScrollHintText.alignment = TextAnchor.MiddleCenter;
            pageScrollHint.gameObject.SetActive(false);

            pageLayer.gameObject.SetActive(false);
        }

        void Show(RectTransform layer)
        {
            layer.gameObject.SetActive(true);
        }

        void Hide(RectTransform layer)
        {
            layer.gameObject.SetActive(false);
        }

        void OpenPage(Page target)
        {
            // 底部导航是唯一常驻的导航，它就得双向可用：再点一次当前这一页，等于收起弹层回应用列表
            if (target != Page.Home && target == page)
            {
                target = Page.Home;
            }

            page = target;
            pageLayer.gameObject.SetActive(target != Page.Home);
            // 弹层开着就把首页那一层收掉：只留一条暗底 + 面板 + 底部导航，
            // 不然面板上沿会露出半行「VR 学习启动器」，像界面没对齐在漏影
            if (mainLayer != null)
            {
                mainLayer.gameObject.SetActive(target == Page.Home);
            }

            RefreshTabs();
            if (target != Page.Home)
            {
                RebuildPage();
            }
        }

        void RebuildPage()
        {
            RefreshTabs();
            switch (page)
            {
                case Page.Usage:
                    RebuildUsage();
                    break;
                case Page.Local:
                    RebuildLocal();
                    break;
                case Page.Settings:
                    RebuildSettings();
                    break;
            }

            if (pageBackText != null)
            {
                pageBackText.text = page == Page.Local ? "回设置页" : "回应用列表";
            }

            // 换页要从头看起：上一滚停在哪跟这一页没关系
            if (pageScroll != null && pageScroll.content != null)
            {
                LayoutRebuilder.ForceRebuildLayoutImmediate(pageScroll.content);
                pageScroll.verticalNormalizedPosition = 1f;
            }

            UpdateScrollHint();
        }

        /// <summary>内容比列表高才显示「下面还有」；矮于一屏的页不显示，免得白给一个提示。</summary>
        void UpdateScrollHint()
        {
            if (pageScrollHint == null || pageScrollViewport == null || pageScroll == null || pageScroll.content == null)
            {
                return;
            }

            var content = pageScroll.content;
            LayoutRebuilder.ForceRebuildLayoutImmediate(content);
            pageScrollHint.gameObject.SetActive(content.rect.height - pageScrollViewport.rect.height > 24f);
        }

        // ---------- 网格 / 竖排容器 ----------
        RectTransform NewPageGrid(int columns, float cellWidth, float cellHeight)
        {
            Clear(pageHost);
            var host = AddImage(pageHost, "网格", Color.clear).rectTransform;
            Place(host, 0f, 0f, pageHost.sizeDelta.x, 0f);
            var grid = host.gameObject.AddComponent<GridLayoutGroup>();
            grid.cellSize = new Vector2(cellWidth, cellHeight);
            grid.spacing = new Vector2(18f, 16f);
            grid.childAlignment = TextAnchor.UpperLeft;
            grid.constraint = GridLayoutGroup.Constraint.FixedColumnCount;
            grid.constraintCount = columns;
            var fitter = host.gameObject.AddComponent<ContentSizeFitter>();
            fitter.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
            fitter.horizontalFit = ContentSizeFitter.FitMode.Unconstrained;
            pageScroll.content = host;
            return host;
        }

        RectTransform NewPageStack()
        {
            Clear(pageHost);
            var host = AddImage(pageHost, "竖排", Color.clear).rectTransform;
            Place(host, 0f, 0f, pageHost.sizeDelta.x, 0f);
            var stack = host.gameObject.AddComponent<VerticalLayoutGroup>();
            stack.spacing = 14f;
            stack.childAlignment = TextAnchor.UpperLeft;
            stack.childControlWidth = false;
            stack.childControlHeight = false;
            stack.childForceExpandWidth = false;
            var fitter = host.gameObject.AddComponent<ContentSizeFitter>();
            fitter.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
            pageScroll.content = host;
            return host;
        }

        RectTransform AddMiniAction(Transform parent, string name, string glyph, string label, UnityEngine.Events.UnityAction onClick)
        {
            UiCard card;
            var rect = AddCardBase(parent, name, Tint(PanelHi, Accent, 0.16f), PanelHover, Accent, onClick, out card, 24);
            rect.sizeDelta = new Vector2(176f, 52f);

            var badge = AddImage(rect, "图标", new Color(Accent.r, Accent.g, Accent.b, 0.26f), 13).rectTransform;
            Place(badge, 32f, 12f, 28f, 28f);
            var icon = AddText(badge, "图标字", glyph, 16f, Accent);
            Stretch(icon.rectTransform);
            icon.alignment = TextAnchor.MiddleCenter;
            icon.fontStyle = FontStyle.Bold;

            var text = AddText(rect, "标题", label, 18f, Ink);
            Place(text.rectTransform, 68f, 14f, 100f, 24f);
            text.fontStyle = FontStyle.Bold;
            return rect;
        }

        // ---------- 今日时长 ----------
        void RebuildUsage()
        {
            pageTitle.text = "我的时长";
            pageSub.text = "今天每个应用实际跑了多久、还能跑多久；离线时是最后一次同步的值，联网后自动补报。";
            Clear(pageActions);

            var used = bootstrap.UsedTodaySeconds();
            var running = bootstrap.Usage != null && bootstrap.Usage.Running != null;
            var near = 0;
            foreach (var app in bootstrap.Apps)
            {
                if (NearlyOut(app))
                {
                    near += 1;
                }
            }

            SetStat(pageStats[0], "今天一共跑了", Human(used), "按 60 分钟一节课折算", Mint, used / 3600f);
            SetStat(pageStats[1], "正在计时", running ? Compact(RunningName(), 11) : "没有应用",
                running ? "点「结束」就记进报表" : "回应用页点一张卡片开始", running ? Sky : Muted, 0f);
            SetStat(pageStats[2], "快用完了的", near + " 个", "剩余不足 5 分钟", near > 0 ? Warn : Muted, 0f);

            var host = NewPageGrid(2, PageCardWidth, PageCardHeight);
            usageHost = host;
            var apps = bootstrap.Apps;
            if (apps.Length == 0)
            {
                var empty = AddText(host, "空", "还没拉到清单，回应用页按横幅右边的「刷新清单」再要一次。", 20f, Muted);
                Place(empty.rectTransform, 8f, 8f, 900f, 30f);
            }

            foreach (var app in apps)
            {
                if (app != null)
                {
                    BuildUsageCard(app, host);
                }
            }

            LayoutRebuilder.ForceRebuildLayoutImmediate(host);
        }

        string RunningName()
        {
            var running = bootstrap.Usage == null ? null : bootstrap.Usage.Running;
            if (running == null)
            {
                return "没有";
            }

            foreach (var app in bootstrap.Apps)
            {
                if (app != null && app.key == running.appKey)
                {
                    return app.name;
                }
            }

            return string.IsNullOrEmpty(running.packageName) ? "未知应用" : running.packageName;
        }

        void BuildUsageCard(AppItem app, Transform host)
        {
            var running = bootstrap.IsSimulated(app);
            var installed = bootstrap.IsInstalled(app);
            var state = StateOf(app);
            var tone = AppTone(app, running, installed, state);
            var blocked = state != "可运行";

            UiCard card;
            var rect = AddCardBase(host, "时长_" + app.key, blocked ? CardBlocked : Card, blocked ? CardBlockedHover : CardHover, tone,
                delegate { OpenAppDetail(app); }, out card);
            // 左边文字列的宽度按卡片宽度算：卡片加宽时右边那一列胶囊不会压到字上
            var textWidth = PageCardWidth - 240f;

            var mark = blocked ? Muted : CategoryColor(app.category);
            var badge = AddImage(rect, "徽标", new Color(mark.r, mark.g, mark.b, blocked ? 0.18f : 0.34f), 18).rectTransform;
            Place(badge, 12f, 20f, 56f, 56f);
            var glyph = AddText(badge, "徽标字", BadgeText(app), 24f, blocked ? mark : Tint(Ink, mark, 0.55f));
            Stretch(glyph.rectTransform);
            glyph.alignment = TextAnchor.MiddleCenter;
            glyph.fontStyle = FontStyle.Bold;

            var name = AddText(rect, "名称", app.name, 22f, blocked ? Muted : Ink);
            Place(name.rectTransform, 80f, 12f, textWidth, 30f);
            name.fontStyle = FontStyle.Bold;

            var meta = AddText(rect, "信息", app.category + "｜" + InstallStateLine(app), 15f, Muted);
            Place(meta.rectTransform, 82f, 44f, textWidth, 20f);

            var ratio = app.dailyMinutes > 0 ? Mathf.Clamp01(app.usedMinutes / (float) app.dailyMinutes) : 0f;
            var track = AddImage(rect, "进度槽", new Color(0f, 0f, 0f, 0.34f), 4).rectTransform;
            Place(track, 82f, 70f, textWidth, 8f);
            var fill = AddImage(track, "进度", ratio > 0.9f ? Warn : tone, 4).rectTransform;
            Place(fill, 0f, 0f, ratio <= 0f ? 0f : Mathf.Max(8f, textWidth * ratio), 8f);

            var caption = AddText(rect, "额度", MeterLine(app, state), 15f, blocked ? tone : Muted);
            Place(caption.rectTransform, 82f, 84f, textWidth, 24f);

            var pill = AddImage(rect, "状态胶囊", new Color(tone.r, tone.g, tone.b, blocked ? 0.8f : 1f), 16).rectTransform;
            PlaceRight(pill, 16f, 12f, 132f, 32f);
            var status = AddText(pill, "状态", ShortStatus(app, running, installed, state), 17f, InkDark);
            Stretch(status.rectTransform);
            status.alignment = TextAnchor.MiddleCenter;
            status.fontStyle = FontStyle.Bold;

            var button = AddCardButton(rect, "动作", running ? "结束" : "详情", blocked ? Tint(PanelHi, tone, 0.24f) : tone, CardHover, tone, delegate
            {
                if (running)
                {
                    bootstrap.ReturnToLauncher();
                    Toast("已结束《" + app.name + "》", Warn);
                    return;
                }

                OpenAppDetail(app);
            });
            PlaceRight(button, 16f, 54f, 132f, 48f);
            if (!blocked)
            {
                button.Find("文字").GetComponent<Text>().color = InkDark;
            }
        }

        // ---------- 本机应用 ----------
        void RebuildLocal()
        {
            pageTitle.text = "本机应用";
            pageSub.text = "这台头显装了哪些应用、老师有没有把它们收进清单；清单外的应用一打开就会被送回桌面。";

            Clear(pageActions);
            AddMiniAction(pageActions, "重扫卡", "重", "重新扫描", delegate
            {
                bootstrap.ScanLocalApps();
                StartCoroutine(bootstrap.SyncLocalApps());
                Toast("已重新扫描，正在同步给后台…", Accent);
                dirty = true;
            });
            AddMiniAction(pageActions, "上报卡", "报", "再报一次", delegate
            {
                StartCoroutine(bootstrap.SyncLocalApps());
                Toast("正在把本机应用报给后台…", Accent);
            });

            var records = bootstrap.LocalApps;
            var unmanaged = 0;
            foreach (var record in records)
            {
                if (record != null && !record.isSelf && !record.isSystem && bootstrap.FindByPackage(record.packageName) == null)
                {
                    unmanaged += 1;
                }
            }

            SetStat(pageStats[0], "这台装了", records.Count + " 个", bootstrap.LocalScanLine, Grape, 0f);
            SetStat(pageStats[1], "清单外的", unmanaged + " 个", bootstrap.StrictMode ? "一打开就被送回桌面" : "只统计不拦", unmanaged > 0 ? Warn : Muted, 0f);
            SetStat(pageStats[2], "被挡过", bootstrap.ViolationCount + " 次", "老师在网页上能看到明细", bootstrap.ViolationCount > 0 ? Warn : Muted, 0f);

            var host = NewPageGrid(2, PageCardWidth, PageCardHeight);
            localHost = host;
            if (records.Count == 0)
            {
                var empty = AddText(host, "空", "还没扫到应用。按上面的「重新扫描」；PC 模拟时清单文件在\n" + LocalAppScanner.FixturePath, 19f, Muted);
                Place(empty.rectTransform, 8f, 8f, 980f, 60f);
            }

            foreach (var record in records)
            {
                if (record != null)
                {
                    BuildLocalCard(record, host);
                }
            }

            LayoutRebuilder.ForceRebuildLayoutImmediate(host);
        }

        void BuildLocalCard(LocalAppRecord record, Transform host)
        {
            var reason = "";
            var state = bootstrap.ManagedStateOf(record, out reason);
            var managed = bootstrap.FindByPackage(record.packageName) != null;
            var blocked = !managed || state.EndsWith("禁止");
            var tone = record.isSelf ? Muted : (blocked ? Warn : Good);
            var glyph = record.isSelf ? "自" : (record.isSystem ? "系" : "机");

            UiCard card;
            var rect = AddCardBase(host, "本机_" + record.packageName, managed ? Card : CardBlocked, managed ? CardHover : CardBlockedHover, tone,
                delegate { Toast(record.label + "：" + (string.IsNullOrEmpty(reason) ? state : reason), tone); }, out card);
            var textWidth = PageCardWidth - 235f;

            var badge = AddImage(rect, "徽标", new Color(tone.r, tone.g, tone.b, blocked ? 0.18f : 0.32f), 18).rectTransform;
            Place(badge, 12f, 20f, 56f, 56f);
            var icon = AddText(badge, "徽标字", glyph, 24f, Tint(Ink, tone, 0.5f));
            Stretch(icon.rectTransform);
            icon.alignment = TextAnchor.MiddleCenter;
            icon.fontStyle = FontStyle.Bold;

            var name = AddText(rect, "名称", Compact(record.label, 16) + (record.isSelf ? "（本启动器）" : ""), 21f, Ink);
            Place(name.rectTransform, 80f, 12f, textWidth, 28f);
            name.fontStyle = FontStyle.Bold;

            var pkg = AddText(rect, "包名", Compact(record.packageName, 34) + "｜v" + (string.IsNullOrEmpty(record.version) ? "-" : record.version), 14f, Muted);
            Place(pkg.rectTransform, 82f, 42f, textWidth, 20f);

            var tags = (record.isVr ? "VR 应用" : "非 VR") + (record.isSystem ? "｜系统应用" : "｜第三方");
            var stateText = AddText(rect, "状态", tags + "｜" + state, 15f, tone);
            Place(stateText.rectTransform, 82f, 66f, textWidth, 22f);

            var noteText = AddText(rect, "原因", string.IsNullOrEmpty(reason) ? (managed ? "老师在清单里" : "清单外，白名单模式下会被挡") : reason,
                15f, Muted);
            Place(noteText.rectTransform, 82f, 88f, textWidth, 22f);

            var pill = AddImage(rect, "结论胶囊", new Color(tone.r, tone.g, tone.b, managed ? 1f : 0.82f), 16).rectTransform;
            PlaceRight(pill, 16f, 12f, 122f, 32f);
            var status = AddText(pill, "结论", managed ? (state.EndsWith("禁止") ? "已禁止" : "已纳管") : "清单外", 17f, InkDark);
            Stretch(status.rectTransform);
            status.alignment = TextAnchor.MiddleCenter;
            status.fontStyle = FontStyle.Bold;

            var open = AddCardButton(rect, "模拟", "模拟打开", Tint(PanelHi, tone, 0.22f), CardHover, tone, delegate
            {
                var error = bootstrap.SimulateForegroundApp(record.packageName);
                Toast(string.IsNullOrEmpty(error) ? "已打开《" + record.label + "》" : "被拦下：" + error, string.IsNullOrEmpty(error) ? Good : Bad);
                dirty = true;
            });
            PlaceRight(open, 16f, 54f, 122f, 48f);
        }

        /// <summary>「本机应用」页当前的卡片数（供无头自检用）。</summary>
        public int LocalRowCount
        {
            get { return localHost == null ? 0 : localHost.childCount; }
        }

        // ---------- 设置 ----------
        /// <summary>
        /// 设置页 = 学生端所有"功能性"的东西：本机应用、管控模式、后台地址、权限、令牌、退出、日志。
        /// 首页只留应用卡，这一页才放运维类的卡，平时不用碰。
        /// </summary>
        void RebuildSettings()
        {
            if (serverInput != null && serverInput.isFocused)
            {
                return;
            }

            pageTitle.text = "设置";
            pageSub.text = "本机应用、管控模式、后台地址、权限、日志都在这一页；平时不用动，连不上才来这里。";
            Clear(pageActions);
            AddMiniAction(pageActions, "刷新清单卡", "刷", "刷新清单", delegate
            {
                StartCoroutine(bootstrap.RefreshManifest());
                Toast("正在问后台要最新清单…", Amber);
            });
            AddMiniAction(pageActions, "重扫卡", "扫", "重扫本机", delegate
            {
                bootstrap.ScanLocalApps();
                StartCoroutine(bootstrap.SyncLocalApps());
                Toast("已重新扫描本机应用，正在同步给后台…", Grape);
                dirty = true;
            });

            var used = bootstrap.UsedTodaySeconds();
            SetStat(pageStats[0], bootstrap.InLesson ? "上课中的学生" : "学生",
                Compact(bootstrap.InLesson ? bootstrap.LessonStudentName : bootstrap.StudentName, 11),
                bootstrap.HasStudent
                    ? "学号 " + bootstrap.StudentNo
                    : (bootstrap.InLesson ? "这节课还没点你的名" : "没在课上·上课当堂定"),
                bootstrap.InLesson ? Sky : (bootstrap.HasStudent ? Good : Warn), 0f);
            SetStat(pageStats[1], "这台头显", Compact(bootstrap.DeviceLabel, 11),
                string.IsNullOrEmpty(bootstrap.PairingCode) ? "已在后台登记" : "配对码 " + bootstrap.PairingCode,
                Amber, 0f);
            SetStat(pageStats[2], "今日时长", Human(used),
                "能跑 " + bootstrap.CountAllowed() + " / 共 " + bootstrap.AppCount + " 个", Grape, used / 3600f);

            var host = NewPageStack();
            var width = pageHost.sizeDelta.x;
            var half = (width - 14f) / 2f;
            var innerHalf = (width - 64f - 14f) / 2f;
            var records = bootstrap.LocalApps;
            var unmanaged = 0;
            foreach (var record in records)
            {
                if (record != null && !record.isSelf && !record.isSystem && bootstrap.FindByPackage(record.packageName) == null)
                {
                    unmanaged += 1;
                }
            }

            // 第一排两张：本机应用 + 管控模式（都是从首页挪过来的功能性信息）
            var topRow = NewRow(host, "本机与管控", width, 178f);
            var local = AddPanelCard(topRow, "本机应用卡", Grape);
            local.sizeDelta = new Vector2(half, 178f);
            var localLabel = AddText(local, "标签", "本机应用", 19f, Ink);
            Place(localLabel.rectTransform, 32f, 14f, half - 56f, 28f);
            localLabel.fontStyle = FontStyle.Bold;
            var localNote = AddText(local, "说明", "这台装了 " + records.Count + " 个应用，其中 " + unmanaged
                + " 个不在老师清单里。\n" + bootstrap.LocalScanLine, 15f, Muted);
            Place(localNote.rectTransform, 32f, 48f, half - 56f, 56f);
            var openLocal = AddCardButton(local, "进入卡", "看本机应用", Tint(PanelHi, Grape, 0.30f), PanelHover, Grape, delegate
            {
                OpenPage(Page.Local);
            });
            Place(openLocal, 32f, 112f, 210f, 52f);

            var mode = AddPanelCard(topRow, "管控模式卡", bootstrap.StrictMode ? Sky : Warn);
            mode.sizeDelta = new Vector2(half, 178f);
            var modeLabel = AddText(mode, "标签", bootstrap.StrictMode ? "管控模式：清单外一律挡住" : "管控模式：只统计不拦", 19f, Ink);
            Place(modeLabel.rectTransform, 32f, 14f, half - 56f, 28f);
            modeLabel.fontStyle = FontStyle.Bold;
            var modeNote = AddText(mode, "说明", "被挡过 " + bootstrap.ViolationCount + " 次｜清单里没装 "
                + bootstrap.MissingInstallCount + " 个\n模式由老师在网页后台切，这里只能看", 15f, Muted);
            Place(modeNote.rectTransform, 32f, 48f, half - 56f, 56f);
            var modeAsk = AddCardButton(mode, "同步卡", "再报一次本机", Tint(PanelHi, Sky, 0.26f), PanelHover, Sky, delegate
            {
                StartCoroutine(bootstrap.SyncLocalApps());
                Toast("正在把本机应用报给后台…", Sky);
            });
            Place(modeAsk, 32f, 112f, 230f, 52f);

            var server = AddPanelCard(host, "后台地址卡", Accent);
            server.sizeDelta = new Vector2(width, 200f);
            var serverLabel = AddText(server, "标签", "后台地址（http://机房电脑IP:8787）", 19f, Ink);
            Place(serverLabel.rectTransform, 32f, 14f, 600f, 28f);
            serverLabel.fontStyle = FontStyle.Bold;
            // 输入框吃掉左边剩余宽度，两颗按钮贴到卡片右边（左右各留 32），弹层加宽也不会空一块
            var findWidth = 210f;
            var saveWidth = 230f;
            var inputWidth = width - 64f - findWidth - saveWidth - 32f;
            serverInput = AddInputField(server, "地址输入", 32f, 50f, inputWidth, 56f);
            serverInput.SetTextWithoutNotify(bootstrap.ServerUrl);
            // 戴着头显敲 IP 太难受，机房换网、后台换了 IP 也容易一直「连不上这个后台」：
            // 这一按钮让这台头显自己扫本网段找后台，地址错了当场改掉
            var find = AddCardButton(server, "自动找卡", "自动找后台", Tint(PanelHi, Mint, 0.26f), PanelHover, Mint, delegate
            {
                if (bootstrap.SearchBackend())
                {
                    Toast("正在扫这一片 254 个地址找后台，几秒就好…", Mint);
                    dirty = true;
                }
                else
                {
                    Toast(bootstrap.BackendSearching ? "已经在扫了，稍等一下" : bootstrap.BackendSearchLine, Warn);
                }
            });
            Place(find, 32f + inputWidth + 16f, 50f, findWidth, 56f);
            var save = AddCardButton(server, "保存卡", "保存并重连", Accent, CardHover, Accent, delegate
            {
                var url = serverInput.text;
                OpenConfirm("换后台地址", "启动器会用 " + url + " 重新登记这台头显，清单和策略会重新拉一次。",
                    "改机房电脑的局域网地址常用这个", "确认换", Accent, delegate
                    {
                        bootstrap.ApplyServerUrl(url);
                        Toast("正在用新地址重新登记…", Accent);
                        dirty = true;
                    });
            });
            Place(save, 32f + inputWidth + 16f + findWidth + 16f, 50f, saveWidth, 56f);
            var serverNote = AddText(server, "说明", "当前：" + bootstrap.ServerUrl + "｜" + bootstrap.StatusText, 15f, Muted);
            Place(serverNote.rectTransform, 32f, 116f, width - 64f, 26f);
            var searchNote = AddText(server, "自动找", bootstrap.BackendSearchLine, 15f, Muted);
            Place(searchNote.rectTransform, 32f, 146f, width - 64f, 26f);

            var device = AddPanelCard(host, "本机信息卡", Mint);
            device.sizeDelta = new Vector2(width, 214f);
            var deviceLabel = AddText(device, "标签", "本机信息（老师按这个对上这台头显）", 19f, Ink);
            Place(deviceLabel.rectTransform, 32f, 14f, 600f, 28f);
            deviceLabel.fontStyle = FontStyle.Bold;
            AddInfoCard(device, "序列号卡", "序列号", bootstrap.Serial, "后台靠它对上这台头显", Ink, 32f, 50f, innerHalf, 118f);
            AddInfoCard(device, "配对码卡", "配对码", string.IsNullOrEmpty(bootstrap.PairingCode) ? "已在后台登记" : bootstrap.PairingCode,
                "老师在网页上按 IP 登记这台时，用它核对是不是这一台", Ink, 32f + innerHalf + 14f, 50f, innerHalf, 118f);
            // 老师在网页上「按 IP 找头显」就是填这一行里的地址，不用再翻序列号
            var identityLine = AddText(device, "问话口", "按 IP 登记这台：" + bootstrap.IdentityLine, 15f, Muted);
            Place(identityLine.rectTransform, 32f, 176f, width - 64f, 26f);

            // 权限卡和操作卡并排两张半宽卡，卡片内部一律按半宽排，说明文字不会压到按钮
            var row = NewRow(host, "权限与操作", width, 190f);
            var permission = AddPanelCard(row, "权限卡", Warn);
            permission.sizeDelta = new Vector2(half, 190f);
            var permissionLabel = AddText(permission, "标签", "查看使用情况的权限", 19f, Ink);
            Place(permissionLabel.rectTransform, 32f, 14f, half - 56f, 28f);
            permissionLabel.fontStyle = FontStyle.Bold;
            var permissionNote = AddText(permission, "说明", "真机上统计第三方应用时长要用它；编辑器里模拟不需要。\n没授权时时长统计会一直是 0。", 15f, Muted);
            Place(permissionNote.rectTransform, 32f, 48f, half - 56f, 58f);
            var grant = AddCardButton(permission, "授权卡", "打开授权", Tint(PanelHi, Warn, 0.26f), PanelHover, Warn, delegate
            {
                AndroidApps.OpenUsageAccessSettings();
                Toast("请给「VR 学习启动器」打开查看使用情况的权限", Warn);
            });
            Place(grant, 32f, 118f, 210f, 54f);

            var danger = AddPanelCard(row, "操作卡", Coral);
            danger.sizeDelta = new Vector2(half, 190f);
            var dangerLabel = AddText(danger, "标签", "要修东西时才动", 19f, Ink);
            Place(dangerLabel.rectTransform, 32f, 14f, half - 56f, 28f);
            dangerLabel.fontStyle = FontStyle.Bold;
            var dangerNote = AddText(danger, "说明", "清令牌会重新走一遍登记；退出就回系统桌面，\n后台还在收心跳。", 15f, Muted);
            Place(dangerNote.rectTransform, 32f, 48f, half - 56f, 58f);
            var token = AddCardButton(danger, "令牌卡", "清令牌重登记", Tint(PanelHi, Warn, 0.26f), PanelHover, Warn, delegate
            {
                OpenConfirm("清掉本机令牌", "这台头显会重新向后台登记，拿一个新令牌；这节课的安排和学生不受影响。",
                    "换后台、登记不上时用", "确认清", Warn, delegate
                    {
                        bootstrap.ReloadTokenAndRetry();
                        Toast("已清掉令牌，正在重新登记", Warn);
                        dirty = true;
                    });
            });
            Place(token, 32f, 118f, 250f, 54f);
            var quit = AddCardButton(danger, "退出卡", "退出启动器", Tint(PanelHi, Coral, 0.26f), PanelHover, Coral, delegate
            {
                OpenConfirm("退出启动器", "启动器进程会退出，回到 PICO 系统桌面；老师下发的锁定仍然在后台记着。",
                    "要再进来就重新打开「VR 学习启动器」", "确认退出", Coral, delegate
                    {
                        AndroidApps.ExitApp();
                    });
            });
            Place(quit, 292f, 118f, 200f, 54f);

            var log = AddPanelCard(host, "日志卡", Muted);
            log.sizeDelta = new Vector2(width, 256f);
            var logLabel = AddText(log, "标签", "本机事件日志（最近 40 条）", 19f, Ink);
            Place(logLabel.rectTransform, 32f, 14f, 600f, 28f);
            logLabel.fontStyle = FontStyle.Bold;

            var logViewport = AddImage(log, "日志区", new Color(0f, 0f, 0f, 0.30f), 18);
            Place(logViewport.rectTransform, 32f, 50f, width - 64f, 190f);
            logViewport.rectTransform.gameObject.AddComponent<RectMask2D>();
            var logScroll = logViewport.rectTransform.gameObject.AddComponent<ScrollRect>();
            logScroll.horizontal = false;
            logScroll.vertical = true;
            logText = AddText(logViewport.rectTransform, "日志", "", 16f, Muted);
            Place(logText.rectTransform, 16f, 10f, width - 96f, 0f);
            logText.verticalOverflow = VerticalWrapMode.Overflow;
            var logFitter = logText.gameObject.AddComponent<ContentSizeFitter>();
            logFitter.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
            logFitter.horizontalFit = ContentSizeFitter.FitMode.Unconstrained;
            logScroll.viewport = logViewport.rectTransform;
            logScroll.content = logText.rectTransform;

            var entries = bootstrap.LogEntries;
            var builder = new System.Text.StringBuilder();
            var start = Mathf.Max(0, entries.Count - 40);
            for (var i = start; i < entries.Count; i += 1)
            {
                builder.AppendLine(entries[i]);
            }

            logText.text = builder.Length == 0 ? "（还没有日志）" : builder.ToString();

            LayoutRebuilder.ForceRebuildLayoutImmediate(host);
        }

        /// <summary>设置页里"两张半宽卡并排"的容器：竖排里先放一个横排，宽度各占一半。</summary>
        RectTransform NewRow(Transform parent, string name, float width, float height)
        {
            var row = AddImage(parent, name, Color.clear).rectTransform;
            Place(row, 0f, 0f, width, height);
            var layout = row.gameObject.AddComponent<HorizontalLayoutGroup>();
            layout.spacing = 14f;
            layout.childAlignment = TextAnchor.UpperLeft;
            layout.childControlWidth = false;
            layout.childControlHeight = false;
            layout.childForceExpandWidth = false;
            return row;
        }

        static string Compact(string text, int max)
        {
            if (string.IsNullOrEmpty(text) || text.Length <= max)
            {
                return text;
            }

            return text.Substring(0, max) + "…";
        }

        // ---------- 给自动化用的入口 ----------
        /// <summary>回应用列表（关掉所有弹层）。</summary>
        public void ShowMainPanel()
        {
            CloseDialog();
            OpenPage(Page.Home);
        }

        public void ShowUsagePanel()
        {
            CloseDialog();
            OpenPage(Page.Usage);
        }

        public void ShowLocalPanel()
        {
            CloseDialog();
            OpenPage(Page.Local);
        }

        public void ShowSettingsPanel()
        {
            CloseDialog();
            OpenPage(Page.Settings);
        }

        /// <summary>打开一张应用详情卡（优先挑被挡住的，方便看原因）。</summary>
        public void ShowAppDetailPanel()
        {
            var picked = (AppItem)null;
            foreach (var app in bootstrap.Apps)
            {
                if (app == null)
                {
                    continue;
                }

                if (picked == null)
                {
                    picked = app;
                }

                if (!app.allowed)
                {
                    picked = app;
                    break;
                }
            }

            if (picked == null)
            {
                Toast("清单还是空的，先按「刷新清单」", Warn);
                return;
            }

            OpenPage(Page.Home);
            OpenAppDetail(picked);
        }

        /// <summary>启动清单里第一个可运行的应用（供自动化演示「运行中」状态）。</summary>
        public string LaunchFirstAllowedApp()
        {
            foreach (var app in bootstrap.Apps)
            {
                if (app != null && app.allowed)
                {
                    return bootstrap.LaunchApp(app);
                }
            }

            return "没有可运行的应用";
        }
    }
}
