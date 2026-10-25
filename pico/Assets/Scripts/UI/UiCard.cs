using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace VrLauncher.UI
{
    /// <summary>
    /// 卡片交互反馈：鼠标或手柄射线指到卡片时提亮、左侧圆角色条变粗、底部亮起一条高亮线、整张卡轻微放大。
    /// 选中态（当前页签）常驻用 pinnedColor 那张更艳的底色，学生一眼能看出自己在哪一页。
    /// 用的是 uGUI 标准指针事件，所以编辑器里的鼠标和头显里的手柄射线都能触发，不用各写一套。
    /// </summary>
    public class UiCard : MonoBehaviour, IPointerEnterHandler, IPointerExitHandler, ISelectHandler, IDeselectHandler
    {
        public Image background;
        public Image accent;
        public Image highlight;

        public Color baseColor = Color.white;
        public Color hoverColor = Color.white;
        public Color highlightColor = Color.white;
        public Color pinnedColor = Color.white;
        public float hoverScale = 1.02f;
        public float accentWidth = 12f;
        public float accentWidthHover = 18f;

        /// <summary>
        /// 常驻高亮（当前页签这类选中态）。赋值当场就上色，不等下一帧 Update：
        /// 换页和抓图都发生在同一帧，等 Update 就拍到上一页的选中态了。
        /// </summary>
        public bool Pinned
        {
            get { return pinned; }
            set
            {
                if (pinned == value)
                {
                    return;
                }

                pinned = value;
                Apply();
            }
        }

        bool pinned;
        bool hovered;
        float value;

        public void Configure(Color background, Color hover, Color highlight, Color pinned)
        {
            baseColor = background;
            hoverColor = hover;
            highlightColor = highlight;
            pinnedColor = pinned;
        }

        void Update()
        {
            value = Mathf.MoveTowards(value, hovered ? 1f : 0f, Time.unscaledDeltaTime * 7f);
            Apply();
        }

        void Apply()
        {
            if (background != null)
            {
                // 选中态不渐变：它说的是"你就在这一页"，慢半拍会让人以为刚才那下没点着
                var from = Color.Lerp(baseColor, pinnedColor, pinned ? 1f : 0f);
                background.color = Color.Lerp(from, hoverColor, value);
            }

            if (accent != null)
            {
                var size = accent.rectTransform.sizeDelta;
                size.x = Mathf.Lerp(accentWidth, accentWidthHover, value);
                accent.rectTransform.sizeDelta = size;
            }

            if (highlight != null)
            {
                var color = highlightColor;
                color.a = Mathf.Max(value, pinned ? 0.9f : 0f) * 0.92f;
                highlight.color = color;
            }

            transform.localScale = Vector3.one * Mathf.Lerp(1f, hoverScale, value);
        }

        public void OnPointerEnter(PointerEventData data) => hovered = true;

        public void OnPointerExit(PointerEventData data) => hovered = false;

        public void OnSelect(BaseEventData data) => hovered = true;

        public void OnDeselect(BaseEventData data) => hovered = false;
    }
}
