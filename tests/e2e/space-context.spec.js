// Smokes for Phase 3 (Space context inheritance at send time):
//   • ChatPane renders the Space badge when the chat lives in a Space.
//   • ChatPane omits the badge when chat.spaceId is null.
//   • Sidebar hides the "New private" lock button when a Space is active.
//   • Sidebar shows the lock button again when "All chats" is active.
//
// What's NOT covered here (would require a full App mount with mocked
// invoke responses for db_load_chats / space_list / prompts_list /
// memory_read / llm_chat_stream — heavy lift for one assertion):
//   • newTab inside a Space inheriting Space.defaultModel.
//   • New chat inside a Space auto-attaching pinned prompt slugs into
//     attachedPromptsByChat.
//   • handleSend prepending the Space's system_prompt to the outbound
//     message list (logic lives in main.jsx around
//     `spaceSystemMessages`; the assembly order is documented in the
//     `convoMessages = [...memorySystemMessages, ...spaceSystemMessages,
//     ...attachmentSystemMessages, ...promptSystemMessages, ...]`
//     comment block).
//   • Compare-mode (confirmCompareModels) carrying spaceId + auto-
//     attaching pinned prompts. Same shape as single-mode and shares
//     resolveSpaceContextForNewChat().
//
// Those pieces are covered by code-review + the runtime tour rather
// than by Playwright. The two smokes here protect the BADGE and the
// LOCK BUTTON — both directly user-visible, both regression-prone.

const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/e2e/fixtures/playwright.html");
  await page.waitForFunction(() => window.__JSX_READY === true);
});

// Mount ChatPane with a minimal chat + optional `space` prop. Mirrors
// the existing mount helpers in modals.spec.js / compare.spec.js.
async function mountChatPane(page, opts = {}) {
  await page.evaluate((opts) => {
    const Component = window.ChatPane;
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) {
      try { window.__TEST_ROOT.unmount(); } catch (_) {}
    }
    host.innerHTML = "";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(Component, {
        chat: opts.chat || {
          id: "c1",
          title: "Hello",
          messages: [
            { id: "m1", role: "user", content: "hi", time: "now" },
          ],
        },
        model: { id: "m", name: "m", color: "#9bbf83" },
        space: opts.space || null,
        isStreaming: false,
        searchQuery: "",
        onSendDemo: () => {},
        onRename: () => {},
        onEditMessage: () => {},
        onRetryMessage: () => {},
      })
    );
    window.__TEST_ROOT = root;
  }, opts);
}

test("ChatPane: renders Space badge when chat is in a Space", async ({ page }) => {
  await mountChatPane(page, {
    space: { id: "s1", name: "Novel", slug: "novel", color: "amber" },
  });
  const badge = page.locator('[data-chat-space-badge][data-space-id="s1"]');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Novel");
});

test("ChatPane: badge is absent when chat has no Space", async ({ page }) => {
  await mountChatPane(page, { space: null });
  await expect(page.locator("[data-chat-space-badge]")).toHaveCount(0);
});

// ── Sidebar: lock button visibility gated on activeSpaceId ─────────────

async function mountSidebar(page, opts = {}) {
  await page.evaluate((opts) => {
    window.__NEW_PRIVATE_CALLS = 0;
    const Component = window.Sidebar;
    const host = document.getElementById("test-root");
    if (window.__TEST_ROOT) {
      try { window.__TEST_ROOT.unmount(); } catch (_) {}
    }
    host.innerHTML = "";
    const root = ReactDOM.createRoot(host);
    root.render(
      React.createElement(Component, {
        chats: { dateSections: [] },
        
        spaces: opts.spaces || [],
        activeSpaceId: opts.activeSpaceId ?? null,
        activeId: null,
        onPick: () => {},
        onDelete: () => {},
        onRename: () => {},
        query: "",
        onQuery: () => {},
        onNew: () => {},
        onNewPrivate: () => { window.__NEW_PRIVATE_CALLS++; },
        onNewCompare: () => {},
        width: 240,
        onSelectSpace: () => {},
        onCreateSpace: () => Promise.resolve("s-new"),
        onRenameSpace: () => {},
        onRecolorSpace: () => {},
        onDeleteSpace: () => {},
        onMoveChatToSpace: () => {},
        messageHits: [],
      })
    );
    window.__TEST_ROOT = root;
  }, opts);
}

test("Sidebar: private/lock button is visible when no Space is active", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
    activeSpaceId: null,
  });
  await expect(page.getByLabel("New private chat")).toBeVisible();
});

test("Sidebar: private/lock button is HIDDEN when a Space is active", async ({ page }) => {
  await mountSidebar(page, {
    spaces: [
      { id: "s1", name: "Novel", slug: "novel", color: "amber", sortIndex: 0, createdAt: 1, updatedAt: 1 },
    ],
    activeSpaceId: "s1",
  });
  // Lock button has aria-label="New private chat"; toHaveCount(0) is
  // the authoritative absence check.
  await expect(page.getByLabel("New private chat")).toHaveCount(0);
});
