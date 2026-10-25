using System;
using UnityEngine;
using UnityEngine.UI;
using VrLauncher.Core;

namespace VrLauncher.UI
{
    /// <summary>
    /// 卡片式弹窗：详情卡（把一个应用的能不能跑、还能跑多久讲清楚）和确认卡（要换地址、清令牌、退出前先问一句）。
    /// 弹层里的每一条信息本身也是一张卡，不用在小字里找答案。
    /// </summary>
    public partial class LauncherUI
    {
        const float DialogWidth = 880f;
        const float DialogHeight = 600f;

        void BuildDialogLayer()
        {
            dialogLayer = AddImage(root, "详情层", new Color(0f, 0f, 0f, 0.76f)).rectTransform;
            Stretch(dialogLayer);

            var card = AddImage(dialogLayer, "卡片", Panel, PanelRadius).rectTransform;
            Center(card, DialogWidth, DialogHeight);

            var bar = AddImage(card, "色条", Accent, 5).rectTransform;
            PlaceBar(bar, 16f, 10f, 26f);

            dialogBadge = AddImage(card, "徽标底", new Color(Accent.r, Accent.g, Accent.b, 0.22f), 28).rectTransform.GetComponent<Image>();
            Place(dialogBadge.rectTransform, 30f, 24f, 96f, 96f);
            dialogBadgeAccent = AddImage(dialogBadge.rectTransform, "徽标条", Accent, 3).rectTransform.GetComponent<Image>();
            PlaceBar(dialogBadgeAccent.rectTransform, 0f, 6f, 8f);
            dialogGlyph = AddText(dialogBadge.rectTransform, "徽标字", "", 34f, Accent);
            Stretch(dialogGlyph.rectTransform);
            dialogGlyph.alignment = TextAnchor.MiddleCenter;
            dialogGlyph.fontStyle = FontStyle.Bold;

            dialogTitle = AddText(card, "标题", "", 30f, Ink);
            Place(dialogTitle.rectTransform, 142f, 22f, 560f, 42f);
            dialogTitle.fontStyle = FontStyle.Bold;

            dialogMeta = AddText(card, "副标题", "", 17f, Muted);
            Place(dialogMeta.rectTransform, 144f, 68f, 560f, 26f);

            var close = AddCardButton(card, "关闭卡", "关闭", Tint(PanelHi, Muted, 0.14f), PanelHover, Muted, CloseDialog);
            PlaceRight(close, 26f, 24f, 132f, 48f);

            dialogBody = AddImage(card, "内容", Color.clear).rectTransform;
            Place(dialogBody, 26f, 134f, DialogWidth - 52f, 372f);

            dialogFooter = AddImage(card, "按钮区", Color.clear).rectTransform;
            Place(dialogFooter, 26f, 522f, DialogWidth - 52f, 56f);
            var row = dialogFooter.gameObject.AddComponent<HorizontalLayoutGroup>();
            row.spacing = 16f;
            row.childAlignment = TextAnchor.MiddleLeft;
            row.childControlWidth = false;
            row.childControlHeight = false;

            dialogLayer.gameObject.SetActive(false);
        }

        /// <summary>应用详情卡：状态、原因、已用、剩余、时段、策略来源，一项一张小卡。</summary>
        void OpenAppDetail(AppItem app)
        {
            if (app == null)
            {
                return;
            }

            detailApp = app;
            var running = bootstrap.IsSimulated(app);
            var installed = bootstrap.IsInstalled(app);
            var state = StateOf(app);
            var tone = AppTone(app, running, installed, state);

            Show(dialogLayer);
            dialogTitle.text = app.name;
            dialogMeta.text = app.category + "｜v" + (string.IsNullOrEmpty(app.version) ? "-" : app.version);
            ApplyTone(dialogBadge, tone, 0.22f);
            dialogBadgeAccent.color = tone;
            dialogGlyph.color = tone;
            dialogGlyph.text = BadgeText(app);

            Clear(dialogBody);
            var width = (DialogWidth - 52f - 18f) / 2f;
            var left = 0f;
            var right = width + 18f;
            var installNote = installed ? (string.IsNullOrEmpty(app.installedVersion) ? "这台头显装了它" : "这台装的是 v" + app.installedVersion) : "这台没装，装了才能点开";
            var why = !installed ? "这台头显没装它，先让老师装好再开放"
                : (app.allowed ? "老师没额外限制，随时可以跑"
                : (string.IsNullOrEmpty(app.reason) ? "老师在后台没开放这个应用" : app.reason));
            var rest = Remaining(app);
            var restTone = NearlyOut(app) ? Warn : Ink;

            AddInfoCard(dialogBody, "信息_状态", "现在能不能跑", ShortStatus(app, running, installed, state),
                installed ? ScopeLine(app.scope) : installNote, tone, left, 0f, width, 108f);
            AddInfoCard(dialogBody, "信息_原因", "为什么是这个结果", Compact(why, 26), "", tone, right, 0f, width, 108f);
            AddInfoCard(dialogBody, "信息_已用", "今日已用", Human(app.usedMinutes * 60),
                app.usedMinutes > 0 ? "已经计入后台报表" : "今天还没有记录", Ink, left, 124f, width, 108f);
            AddInfoCard(dialogBody, "信息_剩余", "还能跑多久",
                rest < 0 ? "不限时长" : rest + " 分钟",
                app.dailyMinutes > 0 ? "每日上限 " + app.dailyMinutes + " 分钟" : "后台没设每日上限", restTone, right, 124f, width, 108f);
            AddInfoCard(dialogBody, "信息_时段", "允许时段", TimeRange(app.window),
                string.IsNullOrEmpty(app.window) ? "全天可跑" : "到点自动挡", Ink, left, 248f, width, 108f);
            AddInfoCard(dialogBody, "信息_本机", "这台装没装", InstallStateLine(app),
                bootstrap.StrictMode ? "白名单模式：清单外一律送回桌面" : "只统计模式：不拦，只记录", Ink, right, 248f, width, 108f);

            Clear(dialogFooter);
            if (running)
            {
                var stop = AddCardButton(dialogFooter, "结束卡", "结束这个应用", PanelHi, PanelHover, Warn, delegate
                {
                    bootstrap.ReturnToLauncher();
                    CloseDialog();
                    Toast("已结束《" + app.name + "》，时长已记上", Warn);
                });
                Place(stop, 0f, 0f, 220f, 56f);
            }
            else if (app.allowed && installed)
            {
                var go = AddCardButton(dialogFooter, "进入卡", "进入应用", Accent, CardHover, Accent, delegate
                {
                    CloseDialog();
                    OnCardClicked(app);
                });
                Place(go, 0f, 0f, 240f, 56f);
                go.Find("文字").GetComponent<Text>().color = InkDark;
            }
            else
            {
                var retry = AddCardButton(dialogFooter, "刷新卡", "问后台要最新清单", Tint(PanelHi, Accent, 0.20f), PanelHover, Accent, delegate
                {
                    StartCoroutine(bootstrap.RefreshManifest());
                    Toast("正在向后台要最新清单…", Accent);
                });
                Place(retry, 0f, 0f, 250f, 56f);
            }

            var back = AddCardButton(dialogFooter, "返回卡", "回应用列表", Tint(PanelHi, Muted, 0.14f), PanelHover, Muted, CloseDialog);
            Place(back, 0f, 0f, 180f, 56f);
        }

        /// <summary>确认卡：动到令牌、地址、进程之前先让卡片问一句，别点头显手柄点错。</summary>
        void OpenConfirm(string title, string body, string note, string okLabel, Color tone, Action onConfirm)
        {
            detailApp = null;
            Show(dialogLayer);
            dialogTitle.text = title;
            dialogMeta.text = note;
            ApplyTone(dialogBadge, tone, 0.22f);
            dialogBadgeAccent.color = tone;
            dialogGlyph.color = tone;
            dialogGlyph.text = "确";

            Clear(dialogBody);
            AddInfoCard(dialogBody, "说明", "会发生什么", body, "", tone, 0f, 0f, DialogWidth - 52f, 150f);

            Clear(dialogFooter);
            var ok = AddCardButton(dialogFooter, "确认卡", okLabel, tone, CardHover, tone, delegate
            {
                CloseDialog();
                if (onConfirm != null)
                {
                    onConfirm();
                }
            });
            Place(ok, 0f, 0f, 240f, 56f);
            ok.Find("文字").GetComponent<Text>().color = InkDark;

            var cancel = AddCardButton(dialogFooter, "取消卡", "先不", Tint(PanelHi, Muted, 0.14f), PanelHover, Muted, CloseDialog);
            Place(cancel, 0f, 0f, 150f, 56f);
        }

        void CloseDialog()
        {
            detailApp = null;
            if (dialogLayer != null)
            {
                dialogLayer.gameObject.SetActive(false);
            }
        }

        // ---------- 弹窗里的小构件 ----------
        /// <summary>动作卡（按钮）：默认就是胶囊圆角，亮底配深色字，学生隔着两步远也认得出哪个能按。</summary>
        RectTransform AddCardButton(Transform parent, string name, string label, Color background, Color hover, Color tone,
            UnityEngine.Events.UnityAction onClick, int radius = ChipRadius)
        {
            UiCard card;
            var rect = AddCardBase(parent, name, background, hover, tone, onClick, out card, radius);
            // 按钮这么小的卡片不需要左侧色条：12 宽的色条塞进 150×56 的按钮里，
            // 看着像一个没点亮的小图标位，反而干扰读按钮文字。大卡片上的色条保留。
            var accent = rect.Find("色条");
            if (accent != null)
            {
                UnityEngine.Object.Destroy(accent.gameObject);
            }

            var text = AddText(rect, "文字", label, 20f, Ink);
            Stretch(text.rectTransform);
            text.alignment = TextAnchor.MiddleCenter;
            text.fontStyle = FontStyle.Bold;
            return rect;
        }

        RectTransform AddPanelCard(Transform parent, string name, Color tone)
        {
            var rect = AddImage(parent, name, Tint(PanelHi, tone, 0.10f), ChipRadius).rectTransform;
            var bar = AddImage(rect, "色条", tone, 5).rectTransform;
            PlaceBar(bar, 14f, 10f, 16f);
            return rect;
        }

        /// <summary>一张信息卡：标题 + 正文 + 补充说明，正文允许两行，长原因不用截断。</summary>
        void AddInfoCard(Transform parent, string name, string label, string value, string note, Color tone,
            float x, float y, float width, float height)
        {
            var rect = AddPanelCard(parent, name, tone);
            Place(rect, x, y, width, height);

            var labelText = AddText(rect, "标签", label, 15f, Muted);
            Place(labelText.rectTransform, 36f, 12f, width - 56f, 20f);

            var valueText = AddText(rect, "数值", string.IsNullOrEmpty(value) ? "-" : value, 20f, tone);
            Place(valueText.rectTransform, 36f, 36f, width - 56f, string.IsNullOrEmpty(note) ? height - 50f : 52f);
            valueText.fontStyle = FontStyle.Bold;

            if (string.IsNullOrEmpty(note))
            {
                return;
            }

            var noteText = AddText(rect, "说明", note, 15f, Muted);
            Place(noteText.rectTransform, 36f, height - 32f, width - 56f, 24f);
        }

        // ---------- 文字加工 ----------
        static string Human(int seconds)
        {
            return UsageRecorder.HumanSeconds(seconds);
        }

        /// <summary>后台的 allow 时段（形如 14:00-16:00）翻成更好读的一句话。</summary>
        static string TimeRange(string window)
        {
            if (string.IsNullOrEmpty(window))
            {
                return "全天";
            }

            return window.Contains("-") ? window.Replace("-", " 到 ") : window;
        }

        static string ScopeLine(string scope)
        {
            switch (scope)
            {
                case "device":
                    return "这台头显的专属策略";
                case "student":
                    return "这个学生的策略";
                case "class":
                    return "整个班级的策略";
                case "global":
                    return "后台全局策略";
                default:
                    return "应用默认设置";
            }
        }
    }
}
