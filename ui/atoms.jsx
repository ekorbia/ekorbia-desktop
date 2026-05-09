// atoms.jsx -- Small reusable widgets used by every panel.
//   TrafficLights, IconButton, ModelDot, Resizer.
// Depends on: tokens.jsx (T), icons.jsx (I.*).

// ─── Tiny atoms ─────────────────────────────────────────────
function TrafficLights({ onRed, onYellow }) {
  const dot = (bg, key, click) => (
    <button
      key={key}
      onClick={click}
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        background: bg,
        border: "none",
        padding: 0,
        cursor: "pointer",
        boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.3)",
      }}
    />
  );
  return (
    <div
      style={{ display: "flex", gap: 8, alignItems: "center", paddingLeft: 4 }}
    >
      {dot("#ff5f57", "r", onRed)}
      {dot("#febc2e", "y", onYellow)}
      {dot("#28c940", "g")}
    </div>
  );
}

function IconButton({
  icon: Ico,
  onClick,
  active,
  title,
  size = 26,
  children,
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: children ? "auto" : size,
        height: size,
        padding: children ? "0 8px" : 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        background: active ? T.bg4 : hover ? T.bg3 : "transparent",
        border: "none",
        borderRadius: 5,
        cursor: "pointer",
        color: active ? T.fg : T.fg2,
        fontFamily: T.mono,
        fontSize: 11,
      }}
    >
      {Ico && <Ico size={13} />}
      {children}
    </button>
  );
}

function ModelDot({ color, size = 7, glow = true }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        boxShadow: glow ? `0 0 6px ${color}88` : "none",
        display: "inline-block",
      }}
    />
  );
}

function Resizer({ onDrag, side = "right" }) {
  const onPointerDown = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const onMove = (ev) => onDrag(ev.clientX - startX, ev.clientX);
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        width: 4,
        flexShrink: 0,
        cursor: "col-resize",
        background: "transparent",
        transition: "background 0.15s",
        zIndex: 5,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = T.amber + "60")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    />
  );
}
