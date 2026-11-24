package app.boop.marmot

import dev.ipf.marmotkit.*

internal fun MarkdownDocumentFfi.document(): Document = mapOf(
  "blocks" to blocks.map { it.document() },
  "truncated" to truncated,
)

private fun MarkdownBlockFfi.document(): Document = when (this) {
  is MarkdownBlockFfi.Paragraph -> node("paragraph", children = inlines.map { it.document() })
  is MarkdownBlockFfi.Heading -> node("heading", children = inlines.map { it.document() }) + ("level" to level.toInt())
  MarkdownBlockFfi.ThematicBreak -> node("break")
  is MarkdownBlockFfi.CodeBlock -> node("code", content)
  is MarkdownBlockFfi.MathBlock -> node("math", content)
  is MarkdownBlockFfi.BlockQuote -> node("quote", children = blocks.map { it.document() })
  is MarkdownBlockFfi.ListBlock -> node("list", children = items.mapIndexed { index, item ->
    val marker = when (val style = kind) {
      is MarkdownListKindFfi.Bullet -> "•"
      is MarkdownListKindFfi.Ordered -> "${style.start.toLong() + index}${style.delimiter}"
    }
    node("listItem", item.checked?.let { if (it) "$marker ☑" else "$marker ☐" } ?: marker,
      item.blocks.map { it.document() })
  })
  is MarkdownBlockFfi.Table -> node("table", children = (listOf(header) + rows).map { row ->
    node("tableRow", children = row.map { node("tableCell", children = it.inlines.map { inline -> inline.document() }) })
  })
  is MarkdownBlockFfi.Details -> node("details", children = listOf(node("paragraph", children = summary.map { it.document() })) +
    body.map { it.document() })
}

private fun MarkdownInlineFfi.document(): Document = when (this) {
  is MarkdownInlineFfi.Text -> node("text", content)
  MarkdownInlineFfi.SoftBreak, MarkdownInlineFfi.HardBreak -> node("text", "\n")
  is MarkdownInlineFfi.Code -> node("code", content)
  is MarkdownInlineFfi.Math -> node("math", content)
  is MarkdownInlineFfi.Emph -> node("italic", children = children.map { it.document() })
  is MarkdownInlineFfi.Strong -> node("bold", children = children.map { it.document() })
  is MarkdownInlineFfi.Strikethrough -> node("strike", children = children.map { it.document() })
  is MarkdownInlineFfi.Link -> link(dest, classification, children.map { it.document() })
  is MarkdownInlineFfi.Image -> node("paragraph", children = alt.map { it.document() })
  is MarkdownInlineFfi.Autolink -> link(when (kind) {
    MarkdownAutolinkKindFfi.WWW -> "https://$url"
    MarkdownAutolinkKindFfi.EMAIL -> "mailto:$url"
    MarkdownAutolinkKindFfi.URI -> url
  }, classification, listOf(node("text", url)))
  is MarkdownInlineFfi.NostrMention -> node("nostr", entity.bech32)
  is MarkdownInlineFfi.NostrUri -> node("nostr", entity.bech32)
  is MarkdownInlineFfi.Timestamp -> node("timestamp", unixSeconds.toString()) + ("style" to style.name.lowercase())
}

private fun link(url: String, classification: MarkdownLinkDestinationKindFfi, children: List<Document>): Document =
  node("link", children = children) + if (classification in setOf(MarkdownLinkDestinationKindFfi.WEB, MarkdownLinkDestinationKindFfi.CONTACT)) {
    mapOf("destination" to url)
  } else emptyMap()

private fun node(kind: String, text: String? = null, children: List<Document>? = null): Document = when {
  children == null && text == null -> mapOf("kind" to kind)
  children == null -> mapOf("kind" to kind, "text" to text)
  text == null -> mapOf("kind" to kind, "children" to children)
  else -> mapOf("kind" to kind, "text" to text, "children" to children)
}
