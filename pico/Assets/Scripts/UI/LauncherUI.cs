using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using VrLauncher.Core;
using VrLauncher.Integration;

namespace VrLauncher.UI
{
    /// <summary>
    /// 启动器界面：全部在运行时用 uGUI 搭出来，工程里不依赖场景/预制体/字体资源。
    /// 所有交互一律收进「卡片」：应用卡、状态卡、页签卡、详情卡、确认卡，
    /// 卡片自带状态色、进度条和按钮，被挡住时在卡片里就把原因说清楚，不再只弹一条 toast。
    /// 画布 World Space 摆在面前 2 米；编辑器里鼠标直接点，头显里由 XrPointerDriver 接手柄射线。
    /// </summary>
    [DefaultExecutionOrder(100)]
    public partial class LauncherUI : MonoBehaviour
    {
        const float Width = 1280f;
        const float Height = 840f;

        const float Margin = 24f;
        const float ContentWidth = Width - Margin * 2f;

        const float BarHeight = 76f;
        const float BarTop = 22f;
        const float BannerTop = 118f;
        const float BannerHeight = 148f;
        const float ListTop = 288f;
        const float ListHeight = 404f;
        const float NavTop = 712f;
        const float NavHeight = 96f;
        // 底部导航：三个页面页签等宽，右边隔开一段再放「回桌面」这个动作（它不是页面，不该混在一起）
        const float DesktopWidth = 236f;
        const float NavGap = 30f;
        // 画布铺满视锥时留的安全边距：1.0 是完全贴边，稍微收一点看着不憋
        const float FillRatio = 0.98f;
        const string DefaultSubtitle = "点一张卡片就能进 · 能不能跑、能跑多久都写在卡片上";
        const float AppCardWidth = 592f;
        const float AppCardHeight = 168f;

        // 圆角档位：卡片 / 弹层 / 按钮胶囊 / 高亮线，界面里一个直角都没有
        const int CardRadius = 28;
        const int PanelRadius = 34;
        const int ChipRadius = 24;
        const float AccentWidth = 12f;
        const float AccentInset = 18f;

        // 弹层不自带页签了：它停在底部导航上方，左右和顶栏、应用列表对成同一栏，
        // 高度按「导航条上沿 - 20」算出来，卡片再也不会藏到导航条底下。
        const float PanelLeft = Margin;
        const float PanelTop = 40f;
        const float PanelWidth = ContentWidth;
        const float PanelHeight = NavTop - PanelTop - 20f;
        const float PanelInner = PanelWidth - 56f;
        const float PageStatTop = 96f;
        const float PageStatHeight = 100f;
        const float PageListTop = 208f;
        const float PageListHeight = PanelHeight - PageListTop - 28f;
        const float PageCardWidth = (PanelInner - 24f - 18f) / 2f;
        const float PageCardHeight = 118f;

        static readonly Color Background = new Color(0.043f, 0.059f, 0.090f);
        static readonly Color Panel = new Color(0.094f, 0.122f, 0.180f);
        static readonly Color PanelHi = new Color(0.133f, 0.173f, 0.247f);
        static readonly Color PanelHover = new Color(0.184f, 0.231f, 0.318f);
        static readonly Color Card = new Color(0.129f, 0.169f, 0.243f);
        static readonly Color CardHover = new Color(0.188f, 0.239f, 0.333f);
        static readonly Color CardBlocked = new Color(0.145f, 0.153f, 0.176f);
        static readonly Color CardBlockedHover = new Color(0.200f, 0.209f, 0.239f);
        static readonly Color Soft = new Color(1f, 1f, 1f, 0.05f);
        static readonly Color Ink = new Color(0.929f, 0.949f, 0.980f);
        static readonly Color Muted = new Color(0.604f, 0.667f, 0.780f);

        // 五支亮色：学生端的"鲜艳"全靠它们，状态、分类、页签、横幅都从这里取
        static readonly Color Sky = new Color(0.208f, 0.816f, 1f);
        static readonly Color Mint = new Color(0.482f, 0.894f, 0.584f);
        static readonly Color Amber = new Color(1f, 0.702f, 0.278f);
        static readonly Color Coral = new Color(1f, 0.494f, 0.651f);
        static readonly Color Grape = new Color(0.655f, 0.545f, 1f);

        static readonly Color Accent = Sky;
        static readonly Color Good = Mint;
        static readonly Color Warn = Amber;
        static readonly Color Bad = Coral;

        /// <summary>亮色底上的深色字：饱和横幅、彩色按钮、状态胶囊用它，比白字更清楚。</summary>
        static readonly Color InkDark = new Color(0.043f, 0.086f, 0.157f);

        static readonly Dictionary<string, Color> CategoryColors = new Dictionary<string, Color>
        {
            { "运动协调", Sky },
            { "专注训练", Amber },
            { "心理调适", Mint },
        };

        enum Page { Home, Usage, Local, Settings }

        LauncherBootstrap bootstrap;
        Font font;
        Sprite solid;
        static readonly Dictionary<int, Sprite> rounded = new Dictionary<int, Sprite>();

        Page page = Page.Home;
        AppItem detailApp;
        DateTime lastSyncAt = DateTime.MinValue;
        bool dirty = true;
        bool appRunning;
        float nextClock;

        Canvas canvas;
        Camera uiCamera;
        float canvasAspect;
        RectTransform root;

        RectTransform mainLayer;
        RectTransform navLayer;
        Text clockValue;
        Text clockNote;
        Text statusValue;
        Image statusDot;
        Text subtitleLine;
        Image bannerBg;
        Image bannerBadge;
        Text bannerGlyph;
        Text bannerValue;
        Text bannerNote;
        Text bannerChip;
        RectTransform cardHost;
        RectTransform cardList;
        ScrollRect cardScroll;
        Text emptyLine;

        RectTransform pageLayer;
        Text pageTitle;
        Text pageSub;
        RectTransform pageScrollViewport;
        RectTransform pageHost;
        ScrollRect pageScroll;
        readonly StatView[] pageStats = new StatView[3];
        RectTransform pageActions;
        Text pageBackText;
        RectTransform pageScrollHint;
        Text pageScrollHintText;

        RectTransform localHost;
        RectTransform usageHost;
        InputField serverInput;
        Text logText;

        RectTransform dialogLayer;
        RectTransform dialogBody;
        Text dialogTitle;
        Text dialogMeta;
        Image dialogBadge;
        Image dialogBadgeAccent;
        Text dialogGlyph;
        RectTransform dialogFooter;

        RectTransform lockLayer;
        Text lockReason;
        Text lockNote;

        RectTransform toastLayer;
        Image toastIconBg;
        Text toastIcon;
        Text toastText;
        Coroutine toastRoutine;

        class StatView
        {
            public UiCard Card;
            public Text Label;
            public Text Value;
            public Text Note;
            public Image Track;
            public Image Fill;
        }

        class TabView
        {
            public Page Page;
            public UiCard Card;
            public Text Title;
            public Text Note;
        }

        readonly List<TabView> tabs = new List<TabView>();

        // ---------- 生命周期 ----------
        void Awake()
        {
            bootstrap = GetComponent<LauncherBootstrap>();
            if (bootstrap == null)
            {
                bootstrap = LauncherBootstrap.Instance != null ? LauncherBootstrap.Instance : gameObject.AddComponent<LauncherBootstrap>();
            }

            font = ChineseFont.Load();
            EnsureEventSystem();
            EnsureCamera();
            BuildCanvas();
            BuildMainLayer();
            BuildPageLayer();
            // 导航层建在弹层之后：底部导航永远压在弹层上面（蒙层压不到它），
            // 弹层里就不用再重复一套页签，省得两套页签错位叠成重影。
            BuildNavLayer();
            BuildDialogLayer();
            BuildLockLayer();
            BuildToastLayer();
            AttachPointerDriver();
        }

        void OnEnable()
        {
            if (bootstrap != null)
            {
                bootstrap.StateChanged += MarkDirty;
            }

            dirty = true;
        }

        void OnDisable()
        {
            if (bootstrap != null)
            {
                bootstrap.StateChanged -= MarkDirty;
            }
        }

        void Update()
        {
            if (Time.unscaledTime < nextClock)
            {
                return;
            }

            if (Input.GetKeyUp(KeyCode.Escape) || Input.GetKeyUp(KeyCode.Backspace))
            {
                GoBack();
            }

            // 1/2/3 直换页：头显里是手柄点页签，键盘这条留给接了键盘的机器和 PC 模拟
            if (Input.GetKeyUp(KeyCode.Alpha1) || Input.GetKeyUp(KeyCode.Keypad1))
            {
                OpenPage(Page.Home);
            }
            else if (Input.GetKeyUp(KeyCode.Alpha2) || Input.GetKeyUp(KeyCode.Keypad2))
            {
                OpenPage(Page.Usage);
            }
            else if (Input.GetKeyUp(KeyCode.Alpha3) || Input.GetKeyUp(KeyCode.Keypad3))
            {
                OpenPage(Page.Settings);
            }

            if (uiCamera != null && Mathf.Abs(uiCamera.aspect - canvasAspect) > 0.01f)
            {
                FitCanvasToView();
            }

            nextClock = Time.unscaledTime + 1f;
            if (clockValue != null)
            {
                clockValue.text = DateTime.Now.ToString("HH:mm:ss");
                clockNote.text = "同步 " + (lastSyncAt == DateTime.MinValue ? "待连接" : lastSyncAt.ToString("HH:mm:ss"));
            }

            if (bootstrap != null)
            {
                var wasRunning = appRunning;
                RefreshLiveLines();
                if (wasRunning != appRunning)
                {
                    dirty = true;
                }
            }
        }

        void LateUpdate()
        {
            if (!dirty)
            {
                return;
            }

            dirty = false;
            Rebuild();
        }

        void MarkDirty()
        {
            if (bootstrap != null && bootstrap.AppCount > 0)
            {
                lastSyncAt = DateTime.Now;
            }

            dirty = true;
        }

        /// <summary>立刻重绘一次（自动化截图用，不等下一帧 LateUpdate）。</summary>
        public void RefreshNow()
        {
            dirty = false;
            Rebuild();
        }

        // ---------- 环境 ----------
        void EnsureEventSystem()
        {
            if (EventSystem.current != null)
            {
                return;
            }

            var go = new GameObject("事件系统");
            go.transform.SetParent(transform, false);
            go.AddComponent<EventSystem>();
            go.AddComponent<StandaloneInputModule>();
        }

        void EnsureCamera()
        {
            var camera = Camera.main;
            if (camera == null)
            {
                var go = new GameObject("主相机");
                go.transform.SetParent(transform, false);
                camera = go.AddComponent<Camera>();
                go.AddComponent<AudioListener>();
                go.tag = "MainCamera";
            }

            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = Background;
            camera.nearClipPlane = 0.1f;
            camera.fieldOfView = 60f;
            camera.transform.position = new Vector3(0f, 1.6f, -1.4f);
            camera.transform.rotation = Quaternion.identity;
            uiCamera = camera;
        }

        void BuildCanvas()
        {
            var go = new GameObject("启动器画布", typeof(RectTransform));
            go.transform.SetParent(transform, false);
            canvas = go.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.sortingOrder = 10;

            var rt = (RectTransform) go.transform;
            rt.sizeDelta = new Vector2(Width, Height);
            rt.localScale = Vector3.one * 0.0015f;
            rt.localPosition = new Vector3(0f, 1.55f, 0.6f);
            rt.localRotation = Quaternion.identity;
            go.AddComponent<GraphicRaycaster>();
            canvas.worldCamera = uiCamera;
            FitCanvasToView();

            root = rt;
            var bg = AddImage(root, "底板", Background);
            Stretch(bg.rectTransform);
        }

        /// <summary>
        /// 让界面铺满整个视野：按相机视锥算出画布该放大多少（取竖横向里更紧的那个，永远不会切掉内容），
        /// 而不是写死一个缩放值。这样不管采集比例是 16:10、头显单眼偏方、还是编辑器里拖窗口，
        /// 学生看到的都是一整屏界面，而不是一块飘在黑边里的小面板。
        /// 视野比例会变（XR 起来、编辑器改窗口大小），所以 Update 里检测到比例变化就重新铺一次。
        /// </summary>
        void FitCanvasToView()
        {
            if (canvas == null || uiCamera == null)
            {
                return;
            }

            var distance = Mathf.Abs(uiCamera.transform.position.z - canvas.transform.position.z);
            var visibleHeight = 2f * distance * Mathf.Tan(uiCamera.fieldOfView * 0.5f * Mathf.Deg2Rad);
            var scale = Mathf.Min(visibleHeight / Height, visibleHeight * uiCamera.aspect / Width) * FillRatio;
            if (scale <= 0f)
            {
                return;
            }

            canvas.transform.localScale = Vector3.one * scale;
            canvasAspect = uiCamera.aspect;
        }

        void AttachPointerDriver()
        {
            var driver = gameObject.GetComponent<XrPointerDriver>();
            if (driver == null)
            {
                driver = gameObject.AddComponent<XrPointerDriver>();
            }

            driver.Attach(canvas, uiCamera);
        }

        // ---------- 首页 ----------
        void BuildMainLayer()
        {
            mainLayer = AddImage(root, "主界面", Color.clear).rectTransform;
            Stretch(mainLayer);

            var bar = AddImage(mainLayer, "顶栏", Panel, ChipRadius).rectTransform;
            Place(bar, Margin, BarTop, ContentWidth, BarHeight);

            var title = AddText(bar, "标题", "VR 学习启动器", 30f, Ink);
            Place(title.rectTransform, 30f, 9f, 420f, 34f);
            title.fontStyle = FontStyle.Bold;

            subtitleLine = AddText(bar, "副标题", DefaultSubtitle, 16f, Muted);
            Place(subtitleLine.rectTransform, 32f, 44f, 780f, 22f);

            var link = AddImage(bar, "连接卡", PanelHi, 22).rectTransform;
            PlaceRight(link, 288f, 16f, 232f, 44f);
            statusDot = AddImage(link, "状态点", Warn, 7).rectTransform.GetComponent<Image>();
            Place(statusDot.rectTransform, 18f, 15f, 14f, 14f);
            statusValue = AddText(link, "连接状态", "连接中…", 18f, Warn);
            Place(statusValue.rectTransform, 42f, 0f, 178f, 44f);
            statusValue.alignment = TextAnchor.MiddleLeft;
            statusValue.fontStyle = FontStyle.Bold;

            var clock = AddImage(bar, "时间卡", PanelHi, ChipRadius).rectTransform;
            PlaceRight(clock, 24f, 10f, 244f, 56f);
            clockValue = AddText(clock, "时间", DateTime.Now.ToString("HH:mm:ss"), 25f, Ink);
            Place(clockValue.rectTransform, 20f, 5f, 150f, 30f);
            clockValue.fontStyle = FontStyle.Bold;
            clockNote = AddText(clock, "同步", "同步 待连接", 14f, Muted);
            Place(clockNote.rectTransform, 20f, 34f, 210f, 20f);

            BuildBannerCard();
            BuildAppList();
        }

        /// <summary>
        /// 首页横幅：一屏只留最要紧的一句话（现在能跑几个 / 上课中 / 今天用完啦），
        /// 整张卡的底色就是状态色，学生不用读小字也知道现在是什么情况。
        /// 原来的学生卡、设备卡、管控卡全部收进「设置」页，首页不再堆信息。
        /// </summary>
        void BuildBannerCard()
        {
            bannerBg = AddImage(mainLayer, "横幅", Sky, PanelRadius);
            Place(bannerBg.rectTransform, Margin, BannerTop, ContentWidth, BannerHeight);

            bannerBadge = AddImage(bannerBg.rectTransform, "徽标", new Color(1f, 1f, 1f, 0.26f), 30).rectTransform.GetComponent<Image>();
            Place(bannerBadge.rectTransform, 26f, 26f, 96f, 96f);
            bannerGlyph = AddText(bannerBadge.rectTransform, "徽标字", "跑", 42f, InkDark);
            Stretch(bannerGlyph.rectTransform);
            bannerGlyph.alignment = TextAnchor.MiddleCenter;
            bannerGlyph.fontStyle = FontStyle.Bold;

            bannerValue = AddText(bannerBg.rectTransform, "大字", "正在问后台要清单…", 38f, InkDark);
            Place(bannerValue.rectTransform, 142f, 22f, 600f, 52f);
            bannerValue.fontStyle = FontStyle.Bold;

            bannerNote = AddText(bannerBg.rectTransform, "小字", "", 17f, new Color(InkDark.r, InkDark.g, InkDark.b, 0.76f));
            Place(bannerNote.rectTransform, 144f, 80f, 596f, 48f);

            var who = AddImage(bannerBg.rectTransform, "身份卡", new Color(1f, 1f, 1f, 0.24f), ChipRadius).rectTransform;
            PlaceRight(who, 220f, 44f, 232f, 60f);
            bannerChip = AddText(who, "身份", "我是谁？", 19f, InkDark);
            Stretch(bannerChip.rectTransform);
            bannerChip.alignment = TextAnchor.MiddleCenter;
            bannerChip.fontStyle = FontStyle.Bold;

            var dark = new Color(InkDark.r, InkDark.g, InkDark.b, 0.88f);
            var refresh = AddCardButton(bannerBg.rectTransform, "刷新卡", "刷新清单", dark,
                new Color(InkDark.r, InkDark.g, InkDark.b, 0.68f), Ink, delegate
                {
                    StartCoroutine(bootstrap.RefreshManifest());
                    Toast("正在问后台要最新清单…", Ink);
                }, ChipRadius);
            PlaceRight(refresh, 28f, 44f, 168f, 60f);
        }

        void BuildAppList()
        {
            var viewport = AddImage(mainLayer, "应用列表", new Color(0f, 0f, 0f, 0.12f), PanelRadius);
            Place(viewport.rectTransform, Margin, ListTop, ContentWidth, ListHeight);
            viewport.rectTransform.gameObject.AddComponent<RectMask2D>();
            cardScroll = viewport.rectTransform.gameObject.AddComponent<ScrollRect>();
            cardScroll.horizontal = false;
            cardScroll.vertical = true;
            cardScroll.movementType = ScrollRect.MovementType.Elastic;
            cardScroll.scrollSensitivity = 34f;

            var host = AddImage(viewport.rectTransform, "内容", Color.clear).rectTransform;
            Place(host, 16f, 12f, ContentWidth - 32f, 0f);
            var grid = host.gameObject.AddComponent<GridLayoutGroup>();
            grid.cellSize = new Vector2(AppCardWidth, AppCardHeight);
            grid.spacing = new Vector2(16f, 18f);
            grid.childAlignment = TextAnchor.UpperLeft;
            grid.constraint = GridLayoutGroup.Constraint.FixedColumnCount;
            grid.constraintCount = 2;
            var fitter = host.gameObject.AddComponent<ContentSizeFitter>();
            fitter.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
            fitter.horizontalFit = ContentSizeFitter.FitMode.Unconstrained;

            cardHost = host;
            cardScroll.viewport = viewport.rectTransform;
            cardScroll.content = host;
        }

        /// <summary>
        /// 底部导航单独一层、建在弹层之后：它是全局唯一的导航，弹层开着时照样亮着、照样能点，
        /// 换页全在这条上完成。只占导航那一条（不铺满整屏），压不住弹层里其它卡片的点击。
        /// </summary>
        void BuildNavLayer()
        {
            navLayer = AddImage(root, "导航条", Color.clear).rectTransform;
            Place(navLayer, Margin, NavTop, ContentWidth, NavHeight);
            BuildTabs(navLayer, ContentWidth, NavHeight);
        }

        /// <summary>
        /// 应用 / 我的时长 / 设置 三个页面页签，中间一条分隔线，右边才是「回桌面」——
        /// 它是退出动作不是页面，混在页签里会让人以为点完还能点回来。
        /// "本机应用"这类运维项收在设置页里，不再占一个页签位。
        /// </summary>
        void BuildTabs(Transform host, float totalWidth, float height)
        {
            var width = (totalWidth - DesktopWidth - NavGap - 2 * 16f) / 3f;
            AddTab(host, Page.Home, "玩", "应用", 0, width, height);
            AddTab(host, Page.Usage, "时", "我的时长", 1, width, height);
            AddTab(host, Page.Settings, "设", "设置", 2, width, height);

            var deskX = totalWidth - DesktopWidth;
            var divider = AddImage(host, "分隔线", new Color(1f, 1f, 1f, 0.12f), 1).rectTransform;
            Place(divider, deskX - NavGap * 0.5f, height * 0.24f, 3f, height * 0.52f);
            AddDeskAction(host, deskX, DesktopWidth, height);
        }

        void AddTab(Transform host, Page target, string glyph, string label, int index, float width, float height)
        {
            var captured = target;
            var tone = TabTone(target);
            UiCard card;
            var rect = AddCardBase(host, "页签_" + label, Tint(PanelHi, tone, 0.10f), Tint(PanelHover, tone, 0.26f), tone,
                delegate { OpenPage(captured); }, out card, ChipRadius, Tint(PanelHi, tone, 0.40f));
            Place(rect, index * (width + 16f), 0f, width, height);
            PlaceTabContent(rect, glyph, label, "", height, tone);
            tabs.Add(new TabView
            {
                Page = target,
                Card = card,
                Title = rect.Find("标题").GetComponent<Text>(),
                Note = rect.Find("说明").GetComponent<Text>()
            });
        }

        /// <summary>退出动作：底色比页签更淡、不参与选中态，避免被当成"当前页"。</summary>
        void AddDeskAction(Transform host, float x, float width, float height)
        {
            UiCard card;
            var rect = AddCardBase(host, "动作_桌面", Tint(PanelHi, Muted, 0.06f), PanelHover, Muted, delegate
            {
                AndroidApps.BackToHome();
                Toast("已回到系统桌面，要回来点 PICO 启动器就行", Muted);
            }, out card, ChipRadius);
            Place(rect, x, 0f, width, height);
            PlaceTabContent(rect, "桌", "回桌面", "退出到 PICO 桌面", height, Muted);
        }

        /// <summary>每个页签一支固定亮色，颜色本身就成了"我现在在哪一页"的记号。</summary>
        static Color TabTone(Page target)
        {
            switch (target)
            {
                case Page.Usage:
                    return Mint;
                case Page.Local:
                    return Grape;
                case Page.Settings:
                    return Amber;
                default:
                    return Sky;
            }
        }

        void PlaceTabContent(RectTransform rect, string glyph, string label, string note, float height, Color tone)
        {
            var badge = AddImage(rect, "图标", new Color(tone.r, tone.g, tone.b, 0.24f), 14).rectTransform;
            Place(badge, 34f, (height - 44f) * 0.5f, 44f, 44f);
            var icon = AddText(badge, "图标字", glyph, 24f, tone);
            Stretch(icon.rectTransform);
            icon.alignment = TextAnchor.MiddleCenter;
            icon.fontStyle = FontStyle.Bold;

            var title = AddText(rect, "标题", label, 21f, Ink);
            Place(title.rectTransform, 90f, height * 0.17f, rect.sizeDelta.x - 106f, 28f);
            title.fontStyle = FontStyle.Bold;

            var noteTop = height * 0.17f + 28f;
            var noteText = AddText(rect, "说明", note, 14f, Muted);
            Place(noteText.rectTransform, 90f, noteTop, rect.sizeDelta.x - 106f, height - noteTop - 10f);
        }

        // ---------- 卡片基元 ----------
        /// <summary>
        /// 所有可点卡片的地基：圆角底 + 左侧圆角色条 + 底部高亮线。
        /// pinned 是选中态（当前页签）的更艳底色，不传就跟底色一样。
        /// </summary>
        RectTransform AddCardBase(Transform parent, string name, Color background, Color hover, Color tone,
            UnityEngine.Events.UnityAction onClick, out UiCard view, int radius = CardRadius, Color pinned = default(Color))
        {
            var image = AddImage(parent, name, background, radius);
            var accent = AddImage(image.rectTransform, "色条", tone, Mathf.RoundToInt(AccentWidth * 0.5f)).rectTransform;
            PlaceBar(accent, 14f, AccentWidth, AccentInset);
            var highlight = AddImage(image.rectTransform, "高亮线", new Color(tone.r, tone.g, tone.b, 0f), 2).rectTransform;
            PlaceLine(highlight, 4f, 20f, 8f);

            view = image.gameObject.AddComponent<UiCard>();
            view.Configure(background, hover, tone, pinned.a <= 0f ? background : pinned);
            view.background = image;
            view.accent = accent.GetComponent<Image>();
            view.highlight = highlight.GetComponent<Image>();
            view.accentWidth = AccentWidth;
            view.accentWidthHover = AccentWidth + 6f;

            var button = image.gameObject.AddComponent<Button>();
            button.targetGraphic = image;
            var colors = button.colors;
            colors.normalColor = Color.white;
            colors.highlightedColor = Color.white;
            colors.pressedColor = Color.white;
            colors.selectedColor = Color.white;
            colors.disabledColor = Color.white;
            button.colors = colors;
            if (onClick != null)
            {
                button.onClick.AddListener(onClick);
            }

            return image.rectTransform;
        }

        StatView BuildStatCard(Transform parent, string name, float x, float y, float width, float height, string label, Color tone)
        {
            UiCard card;
            var rect = AddCardBase(parent, name, Tint(PanelHi, tone, 0.12f), Tint(PanelHover, tone, 0.22f), tone, null, out card, ChipRadius);
            Place(rect, x, y, width, height);

            var labelText = AddText(rect, "标签", label, 15f, Muted);
            Place(labelText.rectTransform, 34f, 12f, width - 54f, 20f);

            var valueText = AddText(rect, "数值", "-", 24f, Ink);
            Place(valueText.rectTransform, 34f, 34f, width - 54f, 32f);
            valueText.fontStyle = FontStyle.Bold;

            var noteText = AddText(rect, "说明", "", 15f, Muted);
            Place(noteText.rectTransform, 34f, 70f, width - 54f, height - 78f);

            var view = new StatView { Card = card, Label = labelText, Value = valueText, Note = noteText };
            if (height >= 110f)
            {
                var track = AddImage(rect, "进度槽", new Color(0f, 0f, 0f, 0.32f), 3).rectTransform;
                Place(track, 34f, 62f, width - 54f, 6f);
                var fill = AddImage(track, "进度", tone, 3).rectTransform;
                Place(fill, 0f, 0f, 0f, 6f);
                view.Track = track.GetComponent<Image>();
                view.Fill = fill.GetComponent<Image>();
            }

            return view;
        }

        void SetStat(StatView view, string label, string value, string note, Color tone, float ratio)
        {
            if (view == null)
            {
                return;
            }

            view.Label.text = label;
            view.Value.text = value;
            view.Value.color = Ink;
            view.Note.text = note;
            view.Note.color = tone == Good || tone == Accent ? Muted : tone;
            if (view.Fill != null)
            {
                var width = view.Track.rectTransform.sizeDelta.x;
                view.Fill.color = tone;
                view.Fill.rectTransform.sizeDelta = new Vector2(Mathf.Max(0f, width * Mathf.Clamp01(ratio)), 6f);
            }
        }

        /// <summary>把亮色少量揉进底色：卡片有颜色但不刺眼，选中态就是揉得多一点的那一档。</summary>
        static Color Tint(Color basis, Color tone, float amount)
        {
            return Color.Lerp(basis, tone, amount);
        }

        void ApplyTone(Image image, Color tone, float alpha)
        {
            var color = tone;
            color.a = alpha;
            image.color = color;
        }

        // ---------- 轻提示（卡片式）----------
        void BuildToastLayer()
        {
            toastLayer = AddImage(root, "提示条根", Color.clear).rectTransform;
            Stretch(toastLayer);

            var pill = AddImage(toastLayer, "提示条", new Color(0.10f, 0.13f, 0.19f, 0.96f), 40).rectTransform;
            Center(pill, 980f, 80f, 0f, -330f);
            var accent = AddImage(pill, "色条", Accent, 5).rectTransform;
            PlaceBar(accent, 16f, 10f, 18f);

            toastIconBg = AddImage(pill, "图标底", new Color(Accent.r, Accent.g, Accent.b, 0.22f), 22).rectTransform.GetComponent<Image>();
            Place(toastIconBg.rectTransform, 34f, 18f, 44f, 44f);
            toastIcon = AddText(toastIconBg.rectTransform, "图标", "提", 22f, Accent);
            Stretch(toastIcon.rectTransform);
            toastIcon.alignment = TextAnchor.MiddleCenter;
            toastIcon.fontStyle = FontStyle.Bold;

            toastText = AddText(pill, "文字", "", 21f, Ink);
            Place(toastText.rectTransform, 94f, 10f, 866f, 60f);
            toastText.alignment = TextAnchor.MiddleLeft;

            toastLayer.gameObject.SetActive(false);
            toastText.raycastTarget = false;
            toastIcon.raycastTarget = false;
            toastIconBg.raycastTarget = false;
            accent.GetComponent<Image>().raycastTarget = false;
            pill.GetComponent<Image>().raycastTarget = false;
            toastLayer.GetComponent<Image>().raycastTarget = false;
        }

        void Toast(string message)
        {
            Toast(message, Accent);
        }

        void Toast(string message, Color tone)
        {
            if (toastText == null)
            {
                Debug.Log("[提示] " + message);
                return;
            }

            toastText.text = message;
            ApplyTone(toastIconBg, tone, 0.22f);
            toastIcon.color = tone;
            toastLayer.gameObject.SetActive(true);
            if (toastRoutine != null)
            {
                StopCoroutine(toastRoutine);
            }

            toastRoutine = StartCoroutine(HideToastLater(3.8f));
        }

        IEnumerator HideToastLater(float seconds)
        {
            yield return new WaitForSecondsRealtime(seconds);
            if (toastLayer != null)
            {
                toastLayer.gameObject.SetActive(false);
            }
        }

    }
}
