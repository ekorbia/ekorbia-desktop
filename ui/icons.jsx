// icons.jsx — minimal stroke-icon set, Zed-style 16x16

'use strict';
const Icon = ({ d, size = 14, stroke = 'currentColor', sw = 1.5, fill = 'none', style = {} }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }}>
    {typeof d === 'string' ? <path d={d} /> : d}
  </svg>
);

const I = {
  Search:    (p) => <Icon {...p} d={<><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3 3" /></>} />,
  Plus:      (p) => <Icon {...p} d="M8 3v10M3 8h10" />,
  X:         (p) => <Icon {...p} d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  Chevron:   (p) => <Icon {...p} d="M4 6l4 4 4-4" />,
  ChevronL:  (p) => <Icon {...p} d="M10 4L6 8l4 4" />,
  ChevronR:  (p) => <Icon {...p} d="M6 4l4 4-4 4" />,
  Send:      (p) => <Icon {...p} d="M2.5 8h11M9 3.5L13.5 8 9 12.5" />,
  Sidebar:   (p) => <Icon {...p} d={<><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></>} />,
  Sparkle:   (p) => <Icon {...p} d="M8 2l1.2 3.4L12.5 6.5 9.2 7.7 8 11 6.8 7.7 3.5 6.5 6.8 5.4z" sw={1.2} />,
  Pin:       (p) => <Icon {...p} d="M8 2v6M5 4h6M4 8h8M8 8v6" />,
  Library:   (p) => <Icon {...p} d={<><rect x="3" y="2" width="2.5" height="12" /><rect x="6.5" y="2" width="2.5" height="12" /><path d="M10 2.5l3 11" /></>} />,
  History:   (p) => <Icon {...p} d={<><circle cx="8" cy="8" r="5.5" /><path d="M8 4.5V8l2.2 1.5" /></>} />,
  Cmd:       (p) => <Icon {...p} d="M5 5a1.5 1.5 0 110-3 1.5 1.5 0 011.5 1.5V11a1.5 1.5 0 11-1.5 1.5V5zm6 0a1.5 1.5 0 113 0 1.5 1.5 0 01-1.5 1.5H5A1.5 1.5 0 013.5 8a1.5 1.5 0 011.5-1.5h6z" sw={1.2} />,
  Cpu:       (p) => <Icon {...p} d={<><rect x="4" y="4" width="8" height="8" rx="1" /><path d="M6 6h4v4H6z" /><path d="M2 6h2M2 10h2M12 6h2M12 10h2M6 2v2M10 2v2M6 12v2M10 12v2" /></>} sw={1.2} />,
  Edit:      (p) => <Icon {...p} d="M3 13h2.5L13 5.5 10.5 3 3 10.5V13z" />,
  Copy:      (p) => <Icon {...p} d={<><rect x="4" y="4" width="8" height="9" rx="1" /><path d="M2 11V3a1 1 0 011-1h7" /></>} />,
  Refresh:   (p) => <Icon {...p} d={<><path d="M13 4v3.5h-3.5" /><path d="M3 12V8.5h3.5" /><path d="M12.5 7a4.5 4.5 0 00-8.4-1M3.5 9a4.5 4.5 0 008.4 1" /></>} />,
  Folder:    (p) => <Icon {...p} d="M2 4.5A1 1 0 013 3.5h3.5l1.5 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-7z" />,
  Settings:  (p) => <Icon {...p} d={<><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4" /></>} sw={1.2} />,
  Tag:       (p) => <Icon {...p} d={<><path d="M2 8V3a1 1 0 011-1h5l6 6-6 6-6-6z" /><circle cx="5" cy="5" r="0.7" fill="currentColor" /></>} />,
  Stop:      (p) => <Icon {...p} d={<rect x="4" y="4" width="8" height="8" rx="1" />} fill="currentColor" sw={0} />,
  Attach:    (p) => <Icon {...p} d="M11.5 6.5l-5 5a2.5 2.5 0 01-3.5-3.5l6-6a3.5 3.5 0 015 5l-6 6" />,
  Mic:       (p) => <Icon {...p} d={<><rect x="6" y="2" width="4" height="8" rx="2" /><path d="M3.5 8a4.5 4.5 0 009 0M8 12.5v2" /></>} />,
  Trash:     (p) => <Icon {...p} d={<><path d="M3 4.5h10M5.5 4.5V3a1 1 0 011-1h3a1 1 0 011 1v1.5M4.5 4.5l.5 8a1 1 0 001 1h4a1 1 0 001-1l.5-8" /></>} />,
  Down:      (p) => <Icon {...p} d="M4 6l4 4 4-4" sw={1.8} />,
  Dot:       (p) => <Icon {...p} d={<circle cx="8" cy="8" r="3" />} fill="currentColor" sw={0} />,
  Power:     (p) => <Icon {...p} d="M5 4a4.5 4.5 0 106 0M8 2v5" />,
  Tabs:      (p) => <Icon {...p} d="M1.5 5h4l1-1.5h3l1 1.5h4M1.5 5v8h13V5" />,
  Upload:    (p) => <Icon {...p} d="M8 12.5V3M4.5 6.5L8 3l3.5 3.5M2.5 13.5h11" />,
  Check:     (p) => <Icon {...p} d="M3 8.5l3.5 3.5L13 5" sw={1.8} />,
  Eye:       (p) => <Icon {...p} d={<><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>} />,
  Chat:      (p) => <Icon {...p} d="M2 4.5a2 2 0 012-2h8a2 2 0 012 2v4.5a2 2 0 01-2 2H7l-3 2.5V11H4a2 2 0 01-2-2v-4.5z" />,
  // Document with folded-over corner; used by the right-panel Files tab in
  // the title bar so it visually differs from the Library (Prompts) icon.
  File:      (p) => <Icon {...p} d={<><path d="M4 1.5h5l3 3v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-11.5a1 1 0 011-1z" /><path d="M9 1.5v3h3" /></>} />,
  // Bell — used by WatchPanel rows to signal that this watch has OS
  // notifications enabled. Dome with a clapper line + base swing.
  Bell:      (p) => <Icon {...p} d={<><path d="M4 11V8a4 4 0 018 0v3l1 1.5H3L4 11z" /><path d="M7 13a1 1 0 002 0" /></>} />,
  // Three horizontal dots — kebab/menu trigger. Used by the chat header
  // export menu. Filled circles render crisper at 16x16 than stroked ones.
  MoreHoriz: (p) => <Icon {...p} d={<><circle cx="3.5" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12.5" cy="8" r="1.1" /></>} fill="currentColor" sw={0} />,
  // Padlock — used for the private-chat affordance (sidebar button + tab
  // glyph + chat-pane banner). Shackle on top, body below, no keyhole
  // (too detailed at 16x16). Stroked so it inherits color cleanly.
  Lock:      (p) => <Icon {...p} d={<><rect x="3.5" y="7.5" width="9" height="6" rx="1" /><path d="M5.5 7.5V5.5a2.5 2.5 0 015 0V7.5" /></>} />,
  // Two side-by-side columns — used for the compare-mode sidebar affordance
  // and any future "panel layout" cue. Two thin rounded rects so the gap
  // between them reads clearly at 16x16.
  Columns:   (p) => <Icon {...p} d={<><rect x="2.5" y="3" width="5" height="10" rx="0.8" /><rect x="8.5" y="3" width="5" height="10" rx="0.8" /></>} />,
};

window.I = I;
