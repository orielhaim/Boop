import type { Content, ContentNode } from "@/core/marmot/message-content";

const maxText = 16_384;

export function pluginMessageText(raw: string, content?: Content | null) {
  if (raw.length > maxText || content?.truncated) return "";
  if (!content) return raw;
  let visited = 0;
  let size = 0;
  const candidates: string[] = [];
  function collect(nodes: readonly ContentNode[], depth: number) {
    if (depth >= 16) return;
    for (const node of nodes) {
      if (++visited > 1024 || size > maxText) break;
      if (node.kind === "quote" || node.kind === "code" || node.kind === "math")
        continue;
      const text =
        node.kind === "text"
          ? node.text
          : node.kind === "link"
            ? (node.pluginDestination ?? node.destination)
            : undefined;
      if (text) {
        size += text.length + 1;
        if (size <= maxText) candidates.push(text);
      } else if (node.kind !== "link" && "children" in node) {
        collect(node.children, depth + 1);
      }
    }
  }
  collect(content.blocks, 0);
  return candidates.join("\n");
}
