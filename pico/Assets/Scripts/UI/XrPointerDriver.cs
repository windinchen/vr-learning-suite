using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
using UnityEngine.InputSystem.XR;
using UnityEngine.UI;

namespace VrLauncher.UI
{
    /// <summary>
    /// 头显手柄射线 → uGUI：读手柄的指向姿态打到世界空间画布上，再给命中的卡片发
    /// pointerEnter / pointerDown / drag / pointerUp，卡片的悬停高亮和按钮就都能用了。
    /// 编辑器里没有 XR 手柄，这里整帧什么都不做，鼠标继续走 StandaloneInputModule（PC 模拟）。
    /// </summary>
    public class XrPointerDriver : MonoBehaviour
    {
        const float MaxRange = 6f;

        Canvas canvas;
        Camera renderCamera;
        EventSystem eventSystem;
        Material rayMaterial;
        int busyHand = -1;

        readonly List<RaycastResult> results = new List<RaycastResult>();
        readonly Hand[] hands = { new Hand(), new Hand() };

        class Hand
        {
            public GameObject Root;
            public LineRenderer Ray;
            public Transform Cursor;
            public PointerEventData Data;
            public XRController Device;
            public GameObject Hovered;
            public GameObject Pressed;
            public GameObject DragTarget;
            public bool Down;
            public bool HasLast;
            public Vector2 LastScreen;
            public ButtonControl Trigger;
        }

        /// <summary>由 LauncherUI 搭好画布后调用。</summary>
        public void Attach(Canvas target, Camera uiCamera)
        {
            canvas = target;
            renderCamera = uiCamera;
            eventSystem = EventSystem.current;
            if (eventSystem == null)
            {
                Debug.LogWarning("[射线] 没有事件系统，手柄射线交互不启用");
            }
        }

        void Update()
        {
            if (canvas == null || eventSystem == null)
            {
                return;
            }

            UpdateHand(hands[0], XRController.leftHand, 0);
            UpdateHand(hands[1], XRController.rightHand, 1);
        }

        void UpdateHand(Hand hand, XRController device, int index)
        {
            if (device == null || !device.enabled)
            {
                Retire(hand);
                return;
            }

            hand.Device = device;
            var tracked = device as TrackedDevice;
            if (tracked == null)
            {
                Retire(hand);
                return;
            }

            Vector3 position;
            Quaternion rotation;
            if (!TryReadPose(tracked, out position, out rotation))
            {
                Retire(hand);
                return;
            }

            var ray = new Ray(position, rotation * Vector3.forward);
            EnsureRig(hand);
            hand.Root.SetActive(true);
            hand.Root.transform.position = position;
            hand.Root.transform.rotation = rotation;

            if (hand.Data == null)
            {
                hand.Data = new PointerEventData(eventSystem) { pointerId = 25 + index };
            }

            float distance;
            var screen = ToScreenPoint(ray, out distance);
            if (float.IsNaN(screen.x))
            {
                SetRay(hand, false, MaxRange);
                return;
            }

            var data = hand.Data;
            data.button = PointerEventData.InputButton.Middle;
            data.delta = hand.HasLast ? screen - hand.LastScreen : Vector2.zero;
            data.position = screen;
            hand.HasLast = true;
            hand.LastScreen = screen;

            results.Clear();
            eventSystem.RaycastAll(data, results);
            var hit = FirstSelectable(results, out var hitRaycast);
            data.pointerCurrentRaycast = hitRaycast;

            if (hit != hand.Hovered)
            {
                if (hand.Pressed == null && hand.Hovered != null)
                {
                    ExecuteEvents.Execute(hand.Hovered, data, ExecuteEvents.pointerExitHandler);
                }

                hand.Hovered = hit;
                data.pointerEnter = hit;
                if (hit != null)
                {
                    ExecuteEvents.Execute(hit, data, ExecuteEvents.pointerEnterHandler);
                }
            }

            SetRay(hand, true, hit != null ? Mathf.Clamp(distance - 0.02f, 0.15f, MaxRange) : MaxRange);
            MoveCursor(hand, ray, distance, hit != null);

            var trigger = ReadTrigger(hand, device);
            if (trigger && !hand.Down && (busyHand < 0 || busyHand == index))
            {
                Press(hand, hit, data);
                return;
            }

            if (!trigger && hand.Down)
            {
                Release(hand, data);
                return;
            }

            if (trigger && hand.Down && hand.DragTarget != null)
            {
                ExecuteEvents.Execute(hand.DragTarget, data, ExecuteEvents.dragHandler);
            }
        }

        void Press(Hand hand, GameObject hit, PointerEventData data)
        {
            hand.Down = true;
            hand.Pressed = hit;
            busyHand = System.Array.IndexOf(hands, hand);
            if (hit == null)
            {
                return;
            }

            data.eligibleForClick = true;
            data.pressPosition = data.position;
            data.pointerPress = hit;
            data.rawPointerPress = hit;
            data.pointerPressRaycast = data.pointerCurrentRaycast;
            ExecuteEvents.Execute(hit, data, ExecuteEvents.pointerDownHandler);
            hand.DragTarget = ExecuteEvents.GetEventHandler<IDragHandler>(hit);
            if (hand.DragTarget == null)
            {
                return;
            }

            ExecuteEvents.Execute(hand.DragTarget, data, ExecuteEvents.initializePotentialDrag);
            ExecuteEvents.Execute(hand.DragTarget, data, ExecuteEvents.beginDragHandler);
        }

        void Release(Hand hand, PointerEventData data)
        {
            hand.Down = false;
            if (hand.DragTarget != null)
            {
                ExecuteEvents.Execute(hand.DragTarget, data, ExecuteEvents.endDragHandler);
            }

            if (hand.Pressed != null)
            {
                ExecuteEvents.Execute(hand.Pressed, data, ExecuteEvents.pointerUpHandler);
                if (hand.Pressed == hand.Hovered)
                {
                    ExecuteEvents.Execute(hand.Pressed, data, ExecuteEvents.pointerClickHandler);
                }
            }

            data.eligibleForClick = false;
            hand.DragTarget = null;
            hand.Pressed = null;
            if (busyHand == System.Array.IndexOf(hands, hand))
            {
                busyHand = -1;
            }
        }

        void Retire(Hand hand)
        {
            if (hand.Down)
            {
                Release(hand, hand.Data);
            }

            if (hand.Hovered != null && hand.Data != null)
            {
                ExecuteEvents.Execute(hand.Hovered, hand.Data, ExecuteEvents.pointerExitHandler);
            }

            hand.Hovered = null;
            hand.HasLast = false;
            SetRay(hand, false, MaxRange);
        }

        /// <summary>手柄指向优先用 pointer 姿态（指哪打哪），没有就退回设备本体姿态。</summary>
        static bool TryReadPose(TrackedDevice device, out Vector3 position, out Quaternion rotation)
        {
            position = Vector3.zero;
            rotation = Quaternion.identity;

            if (!TryRead(PoseControl<Vector3Control>(device, "pointerPosition", "devicePosition"), out position)
                || !TryRead(PoseControl<QuaternionControl>(device, "pointerRotation", "deviceRotation"), out rotation))
            {
                return false;
            }

            var direction = rotation * Vector3.forward;
            return direction.sqrMagnitude > 0.0001f;
        }

        static TControl PoseControl<TControl>(TrackedDevice device, string primaryPath, string fallbackPath)
            where TControl : InputControl
        {
            var control = device.TryGetChildControl<TControl>(primaryPath);
            return control != null ? control : device.TryGetChildControl<TControl>(fallbackPath);
        }

        static bool TryRead(Vector3Control control, out Vector3 value)
        {
            value = control != null ? control.value : Vector3.zero;
            return !IsNaN(value);
        }

        static bool TryRead(QuaternionControl control, out Quaternion value)
        {
            value = control != null ? control.value : Quaternion.identity;
            return !IsNaN(value);
        }

        /// <summary>扳机键名各家布局不一样，第一次用到时按名字找一次。</summary>
        static bool ReadTrigger(Hand hand, XRController device)
        {
            if (hand.Trigger != null && hand.Trigger.device == device)
            {
                return hand.Trigger.isPressed;
            }

            hand.Trigger = device.TryGetChildControl<ButtonControl>("trigger")
                ?? device.TryGetChildControl<ButtonControl>("triggerButton");
            return hand.Trigger != null && hand.Trigger.isPressed;
        }

        static bool IsNaN(Vector3 value)
        {
            return float.IsNaN(value.x) || float.IsNaN(value.y) || float.IsNaN(value.z);
        }

        static bool IsNaN(Quaternion value)
        {
            return float.IsNaN(value.x) || float.IsNaN(value.y) || float.IsNaN(value.z) || float.IsNaN(value.w);
        }

        /// <summary>取第一个真正能吃射线的成绩，顺便把这条成绩交出去：滚动和按下滑点都要靠它认画布。</summary>
        static GameObject FirstSelectable(List<RaycastResult> hits, out RaycastResult raycast)
        {
            raycast = new RaycastResult();
            for (var i = 0; i < hits.Count; i += 1)
            {
                if (hits[i].gameObject == null)
                {
                    continue;
                }

                var graphic = hits[i].gameObject.GetComponent<Graphic>();
                if (graphic != null && graphic.raycastTarget)
                {
                    raycast = hits[i];
                    return hits[i].gameObject;
                }
            }

            return null;
        }

        /// <summary>射线打画布平面，换算成屏幕坐标——GraphicRaycaster 吃的是屏幕坐标。</summary>
        Vector2 ToScreenPoint(Ray ray, out float distance)
        {
            distance = MaxRange;
            if (renderCamera == null)
            {
                return new Vector2(float.NaN, float.NaN);
            }

            var normal = canvas.transform.forward;
            var denominator = Vector3.Dot(ray.direction, normal);
            if (Mathf.Abs(denominator) < 0.0001f)
            {
                return renderCamera.WorldToScreenPoint(ray.GetPoint(MaxRange));
            }

            var t = Vector3.Dot(canvas.transform.position - ray.origin, normal) / denominator;
            if (t <= 0f || t > MaxRange * 2f)
            {
                return renderCamera.WorldToScreenPoint(ray.GetPoint(MaxRange));
            }

            distance = t;
            return renderCamera.WorldToScreenPoint(ray.GetPoint(Mathf.Max(0.05f, t)));
        }

        void EnsureRig(Hand hand)
        {
            if (hand.Root != null)
            {
                return;
            }

            hand.Root = new GameObject("手柄射线");
            hand.Root.transform.SetParent(transform, false);

            hand.Ray = hand.Root.AddComponent<LineRenderer>();
            hand.Ray.positionCount = 2;
            hand.Ray.SetPosition(0, Vector3.zero);
            hand.Ray.SetPosition(1, new Vector3(0f, 0f, MaxRange));
            hand.Ray.widthMultiplier = 0.006f;
            hand.Ray.numCapVertices = 4;
            hand.Ray.useWorldSpace = false;
            hand.Ray.material = EnsureMaterial();
            hand.Ray.startColor = new Color(0.55f, 0.80f, 1f, 0.85f);
            hand.Ray.endColor = new Color(0.29f, 0.64f, 1f, 0.05f);

            var cursor = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            cursor.name = "射线光点";
            var collider = cursor.GetComponent<Collider>();
            if (collider != null)
            {
                Destroy(collider);
            }

            cursor.transform.SetParent(hand.Root.transform, false);
            cursor.transform.localScale = Vector3.one * 0.012f;
            var renderer = cursor.GetComponent<Renderer>();
            if (renderer != null && EnsureMaterial() != null)
            {
                renderer.sharedMaterial = EnsureMaterial();
            }

            hand.Cursor = cursor.transform;
        }

        Material EnsureMaterial()
        {
            if (rayMaterial != null)
            {
                return rayMaterial;
            }

            foreach (var name in new[] { "Sprites/Default", "UI/Default", "Legacy Shaders/Diffuse" })
            {
                var shader = Shader.Find(name);
                if (shader == null)
                {
                    continue;
                }

                rayMaterial = new Material(shader);
                rayMaterial.hideFlags = HideFlags.HideAndDontSave;
                return rayMaterial;
            }

            Debug.LogWarning("[射线] 找不到可用的 shader，只关掉射线显示，点击仍然有效");
            return null;
        }

        void SetRay(Hand hand, bool visible, float length)
        {
            if (hand.Root == null)
            {
                return;
            }

            hand.Root.SetActive(visible);
            if (hand.Ray != null)
            {
                hand.Ray.SetPosition(1, new Vector3(0f, 0f, Mathf.Clamp(length, 0.05f, MaxRange)));
            }
        }

        void MoveCursor(Hand hand, Ray ray, float distance, bool hit)
        {
            if (hand.Cursor == null)
            {
                return;
            }

            hand.Cursor.gameObject.SetActive(hit);
            if (hit)
            {
                hand.Cursor.position = ray.GetPoint(Mathf.Max(0.05f, distance));
            }
        }

        void OnDestroy()
        {
            if (rayMaterial != null)
            {
                Destroy(rayMaterial);
            }
        }
    }
}
