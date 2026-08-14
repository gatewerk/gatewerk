import { describe, it, expect } from "vitest";
import {
  transformPayload,
  formatSlack,
  formatGeneric,
  formatDiscord,
  formatTelegram,
  escapeMarkdownV2,
  escapeMarkdownV2Code,
  escapeMarkdownV2LinkUrl,
} from "../services/notification-payloads";
import type { NotificationPayload } from "@gatewerk/shared";

const basePayload: NotificationPayload = {
  event: "review.created",
  review_id: "r_123",
  template: "code-review",
  project: "p_456",
  priority: "high",
  url: "/reviews/r_123",
  created_at: "2026-05-19T12:00:00.000Z",
};

describe("transformPayload", () => {
  it("routes generic type to generic transformer (pass-through with absolute url)", () => {
    const out = transformPayload("generic", basePayload, { uiOrigin: "https://app.gatewerk.com" });
    expect(out).toMatchObject({
      event: "review.created",
      review_id: "r_123",
      url: "https://app.gatewerk.com/reviews/r_123",
    });
  });

  it("routes slack type to Slack Block Kit", () => {
    const out = transformPayload("slack", basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    expect(out.text).toContain("Review created");
    expect(Array.isArray(out.blocks)).toBe(true);
    expect(out.blocks[0].type).toBe("header");
  });

  it("routes discord type to Discord embed payload", () => {
    const out = transformPayload("discord", basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    expect(typeof out.content).toBe("string");
    expect(Array.isArray(out.embeds)).toBe(true);
    expect(out.embeds[0].title).toBe("Review created");
    expect(out.embeds[0].url).toBe("https://app.gatewerk.com/reviews/r_123");
  });

  it("routes telegram type to MarkdownV2 sendMessage body", () => {
    const out = transformPayload("telegram", basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    expect(out.parse_mode).toBe("MarkdownV2");
    expect(typeof out.text).toBe("string");
    expect(out.text).toContain("Review created");
    expect(out.disable_web_page_preview).toBe(true);
  });

  it("throws on an unhandled NotificationChannelType (exhaustiveness guard)", () => {
    expect(() =>
      // @ts-expect-error — intentionally passing an out-of-union value to exercise the runtime guard
      transformPayload("unknown_channel_type", basePayload, { uiOrigin: "https://x" }),
    ).toThrow(/Unhandled NotificationChannelType/);
  });
});

describe("formatSlack", () => {
  it("includes text fallback for accessibility / notification center", () => {
    const out = formatSlack(basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    expect(out.text).toBeTruthy();
    expect(typeof out.text).toBe("string");
  });

  it("uses 'primary' button style for high/critical priority", () => {
    const high = formatSlack({ ...basePayload, priority: "high" }, { uiOrigin: "https://x" }) as any;
    const critical = formatSlack({ ...basePayload, priority: "critical" }, { uiOrigin: "https://x" }) as any;
    const normal = formatSlack({ ...basePayload, priority: "normal" }, { uiOrigin: "https://x" }) as any;
    expect(high.blocks.find((b: any) => b.type === "actions").elements[0].style).toBe("primary");
    expect(critical.blocks.find((b: any) => b.type === "actions").elements[0].style).toBe("primary");
    expect(normal.blocks.find((b: any) => b.type === "actions").elements[0].style).toBeUndefined();
  });

  it("renders absolute click-through URL using uiOrigin", () => {
    const out = formatSlack(basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    const button = out.blocks.find((b: any) => b.type === "actions").elements[0];
    expect(button.url).toBe("https://app.gatewerk.com/reviews/r_123");
  });

  it("humanizes event name in header", () => {
    const out = formatSlack({ ...basePayload, event: "review.urgent" }, { uiOrigin: "https://x" }) as any;
    expect(out.blocks[0].text.text).toBe("Review urgent");
  });
});

describe("formatDiscord", () => {
  it("emits {content, embeds[]} with a single structured embed", () => {
    const out = formatDiscord(basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("Review created");
    expect(Array.isArray(out.embeds)).toBe(true);
    expect(out.embeds).toHaveLength(1);
  });

  it("places absolute click-through URL on the embed", () => {
    const out = formatDiscord(basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    expect(out.embeds[0].url).toBe("https://app.gatewerk.com/reviews/r_123");
  });

  it("includes Template, Priority, Project, Review ID fields", () => {
    const out = formatDiscord(basePayload, { uiOrigin: "https://x" }) as any;
    const names = out.embeds[0].fields.map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Template", "Priority", "Project", "Review ID"]));
  });

  it("passes ISO timestamp through to embed", () => {
    const out = formatDiscord(basePayload, { uiOrigin: "https://x" }) as any;
    expect(out.embeds[0].timestamp).toBe("2026-05-19T12:00:00.000Z");
  });

  it("maps embed color by priority", () => {
    const critical = formatDiscord({ ...basePayload, priority: "critical" }, { uiOrigin: "https://x" }) as any;
    const high = formatDiscord({ ...basePayload, priority: "high" }, { uiOrigin: "https://x" }) as any;
    const normal = formatDiscord({ ...basePayload, priority: "normal" }, { uiOrigin: "https://x" }) as any;
    const low = formatDiscord({ ...basePayload, priority: "low" }, { uiOrigin: "https://x" }) as any;
    expect(critical.embeds[0].color).toBe(0xEF4444);
    expect(high.embeds[0].color).toBe(0xEAB308);
    expect(normal.embeds[0].color).toBe(0x22C55E);
    expect(low.embeds[0].color).toBe(0x6B7280);
  });

  it("humanizes event name in embed title", () => {
    const out = formatDiscord({ ...basePayload, event: "review.assignment_escalated" }, { uiOrigin: "https://x" }) as any;
    expect(out.embeds[0].title).toBe("Review assignment escalated");
  });
});

describe("formatTelegram", () => {
  it("emits text + parse_mode: MarkdownV2 + disable_web_page_preview", () => {
    const out = formatTelegram(basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    expect(out.parse_mode).toBe("MarkdownV2");
    expect(out.disable_web_page_preview).toBe(true);
    expect(typeof out.text).toBe("string");
  });

  it("does NOT include chat_id in body (delivered via URL query string)", () => {
    const out = formatTelegram(basePayload, { uiOrigin: "https://x" }) as any;
    expect(out.chat_id).toBeUndefined();
  });

  it("escapes MarkdownV2 reserved chars in interpolated template/project/review_id", () => {
    const out = formatTelegram(
      {
        ...basePayload,
        template: "deploy.review_v2!",
        project: "team-alpha",
        review_id: "r_abc.def",
      },
      { uiOrigin: "https://x" },
    ) as any;
    expect(out.text).toContain("deploy\\.review\\_v2\\!");
    expect(out.text).toContain("team\\-alpha");
    // review_id is rendered inside a code span (`...`) — only ` and \ are escaped there,
    // so underscores and dots stay literal per Telegram's MarkdownV2 code-span rules.
    expect(out.text).toContain("`r_abc.def`");
  });

  it("renders an inline link to the absolutized URL", () => {
    const out = formatTelegram(basePayload, { uiOrigin: "https://app.gatewerk.com" }) as any;
    expect(out.text).toContain("[Open in Gatewerk](https://app.gatewerk.com/reviews/r_123)");
  });

  it("escapes `)` and `\\` inside the link URL", () => {
    const out = formatTelegram(
      { ...basePayload, url: "/reviews/r(1)" },
      { uiOrigin: "https://app.gatewerk.com" },
    ) as any;
    expect(out.text).toContain("(https://app.gatewerk.com/reviews/r(1\\))");
  });
});

describe("escapeMarkdownV2 helpers", () => {
  it("escapes every Telegram MarkdownV2 reserved char in regular text", () => {
    // 18 reserved chars per the spec (_ * [ ] ( ) ~ ` > # + - = | { } . !) + the
    // backslash itself = 19 source chars; each gets a `\` prefix, so output is 38.
    const reserved = "_*[]()~`>#+-=|{}.!\\";
    const escaped = escapeMarkdownV2(reserved);
    expect(reserved.length).toBe(19);
    expect(escaped.length).toBe(38);
    for (const ch of reserved) {
      expect(escaped).toContain(`\\${ch}`);
    }
  });

  it("leaves non-reserved chars untouched", () => {
    expect(escapeMarkdownV2("Hello World 123")).toBe("Hello World 123");
  });

  it("escapeMarkdownV2Code escapes only backtick and backslash", () => {
    expect(escapeMarkdownV2Code("abc`def\\ghi.jkl")).toBe("abc\\`def\\\\ghi.jkl");
  });

  it("escapeMarkdownV2LinkUrl escapes only ) and backslash", () => {
    expect(escapeMarkdownV2LinkUrl("https://x.com/a(b)c\\d.e")).toBe("https://x.com/a(b\\)c\\\\d.e");
  });
});

describe("formatGeneric", () => {
  it("preserves existing absolute URL", () => {
    const out = formatGeneric({ ...basePayload, url: "https://other.com/r/123" }, { uiOrigin: "https://app.gatewerk.com" });
    expect(out.url).toBe("https://other.com/r/123");
  });

  it("upgrades relative URL using uiOrigin", () => {
    const out = formatGeneric(basePayload, { uiOrigin: "https://app.gatewerk.com" });
    expect(out.url).toBe("https://app.gatewerk.com/reviews/r_123");
  });

  it("trims trailing slash on uiOrigin", () => {
    const out = formatGeneric(basePayload, { uiOrigin: "https://app.gatewerk.com/" });
    expect(out.url).toBe("https://app.gatewerk.com/reviews/r_123");
  });

  it("emits the full 7-field NotificationPayload shape for backward compat", () => {
    const out = formatGeneric(basePayload, { uiOrigin: "https://app.gatewerk.com" });
    expect(out).toEqual({
      event: "review.created",
      review_id: "r_123",
      template: "code-review",
      project: "p_456",
      priority: "high",
      url: "https://app.gatewerk.com/reviews/r_123",
      created_at: "2026-05-19T12:00:00.000Z",
    });
  });

  it("returns relative url when uiOrigin is empty (dev/test fallback)", () => {
    expect(formatGeneric(basePayload, { uiOrigin: "" }).url).toBe("/reviews/r_123");
  });
});
