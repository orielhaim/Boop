import { z } from "zod";

const timestampStyle = z.enum([
  "short_time",
  "long_time",
  "short_date",
  "long_date",
  "short_date_time",
  "long_date_time",
  "compact_date_time",
  "compact_date_time_seconds",
  "relative",
]);

const text = z.string();
const contentNode = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["text", "code", "math", "nostr"]), text }),
  z.object({ kind: z.literal("break") }),
  z.object({
    kind: z.literal("timestamp"),
    text: text.regex(/^-?\d{1,19}$/),
    style: timestampStyle,
  }),
  z.object({
    kind: z.enum([
      "paragraph",
      "bold",
      "italic",
      "strike",
      "quote",
      "list",
      "table",
      "tableRow",
      "tableCell",
      "details",
    ]),
    get children(): z.ZodArray<typeof contentNode> {
      return z.array(contentNode);
    },
  }),
  z.object({
    kind: z.literal("link"),
    destination: text.optional(),
    pluginDestination: text.max(4096).optional(),
    get children(): z.ZodArray<typeof contentNode> {
      return z.array(contentNode);
    },
  }),
  z.object({
    kind: z.literal("heading"),
    level: z.number().int().min(1).max(6),
    get children(): z.ZodArray<typeof contentNode> {
      return z.array(contentNode);
    },
  }),
  z.object({
    kind: z.literal("listItem"),
    text,
    get children(): z.ZodArray<typeof contentNode> {
      return z.array(contentNode);
    },
  }),
]);

export const messageContent = z.object({
  truncated: z.boolean(),
  blocks: z.array(contentNode),
});
export type Content = z.output<typeof messageContent>;
export type ContentNode = Content["blocks"][number];

export function hasMention(content: Content) {
  function has(node: ContentNode): boolean {
    return (
      node.kind === "nostr" || ("children" in node && node.children.some(has))
    );
  }
  return content.blocks.some(has);
}

export function mentionLabel(
  entity: string,
  names: ReadonlyMap<string, string>,
) {
  const name = names.get(entity.toLowerCase());
  return name ? `@${name}` : `nostr:${entity}`;
}

type QuotePart =
  | { kind: "text"; text: string }
  | { kind: "mention"; entity: string }
  | { kind: "timestamp"; node: Extract<ContentNode, { kind: "timestamp" }> };

const quotePlans = new WeakMap<Content, QuotePart[] | null>();

function compileQuote(content: Content): QuotePart[] | null {
  const cached = quotePlans.get(content);
  if (cached !== undefined) return cached;
  if (content.truncated || !content.blocks.length) {
    quotePlans.set(content, null);
    return null;
  }

  function joined(groups: QuotePart[][], separator: string): QuotePart[] {
    return groups.flatMap((group, index) =>
      index ? [{ kind: "text" as const, text: separator }, ...group] : group,
    );
  }

  function read(node: ContentNode): QuotePart[] {
    if (node.kind === "nostr") return [{ kind: "mention", entity: node.text }];
    if (node.kind === "break") return [{ kind: "text", text: " " }];
    if (node.kind === "timestamp") return [{ kind: "timestamp", node }];
    if (node.kind === "listItem")
      return [
        { kind: "text", text: `${node.text} ` },
        ...joined(node.children.map(read), " "),
      ];
    if ("children" in node)
      return joined(
        node.children.map(read),
        ["list", "quote", "table", "tableRow", "details"].includes(node.kind)
          ? " "
          : "",
      );
    return [{ kind: "text", text: node.text }];
  }

  const plan = joined(content.blocks.map(read), " ");
  quotePlans.set(content, plan);
  return plan;
}

export function quoteText(
  content: Content,
  fallback: string,
  names: ReadonlyMap<string, string>,
) {
  const plan = compileQuote(content);
  if (!plan) return fallback;
  return plan
    .map((part) => {
      if (part.kind === "mention") return mentionLabel(part.entity, names);
      if (part.kind === "timestamp") return formatTimestamp(part.node);
      return part.text;
    })
    .join("")
    .trim();
}

export function formatTimestamp(
  node: Extract<ContentNode, { kind: "timestamp" }>,
) {
  const seconds = Number(node.text);
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) return node.text;
  if (node.style === "relative") {
    const delta = seconds - Date.now() / 1_000;
    const [unit, divisor]: [Intl.RelativeTimeFormatUnit, number] =
      Math.abs(delta) >= 86400
        ? ["day", 86400]
        : Math.abs(delta) >= 3600
          ? ["hour", 3600]
          : Math.abs(delta) >= 60
            ? ["minute", 60]
            : ["second", 1];
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
      Math.round(delta / divisor),
      unit,
    );
  }
  const options: Record<
    Exclude<typeof node.style, "relative">,
    Intl.DateTimeFormatOptions
  > = {
    short_time: { timeStyle: "short" },
    long_time: { timeStyle: "medium" },
    short_date: { dateStyle: "short" },
    long_date: { dateStyle: "long" },
    short_date_time: { dateStyle: "long", timeStyle: "short" },
    long_date_time: { dateStyle: "full", timeStyle: "short" },
    compact_date_time: { dateStyle: "short", timeStyle: "short" },
    compact_date_time_seconds: { dateStyle: "short", timeStyle: "medium" },
  };
  return date.toLocaleString(undefined, options[node.style]);
}
