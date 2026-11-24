func messageContent(_ doc: MarkdownDocumentFfi) -> Document {
  ["blocks": doc.blocks.map(block), "truncated": doc.truncated]
}

private func block(_ value: MarkdownBlockFfi) -> Document {
  switch value {
  case .paragraph(let inlines): return node("paragraph", children: inlines.map(inline))
  case .heading(let level, let inlines):
    return adding(node("heading", children: inlines.map(inline)), "level", Int(level))
  case .thematicBreak: return node("break")
  case .codeBlock(_, _, let content): return node("code", content)
  case .mathBlock(let content): return node("math", content)
  case .blockQuote(let blocks, _): return node("quote", children: blocks.map(block))
  case .listBlock(let kind, _, let items):
    return node("list", children: items.enumerated().map { index, item in
      let marker: String
      switch kind {
      case .bullet: marker = "•"
      case .ordered(let start, let delimiter): marker = "\(UInt64(start) + UInt64(index))\(delimiter)"
      }
      let suffix = item.checked.map { $0 ? " ☑" : " ☐" } ?? ""
      return node("listItem", marker + suffix, children: item.blocks.map(block))
    })
  case .table(_, let header, let rows):
    return node("table", children: ([header] + rows).map { row in
      node("tableRow", children: row.map { node("tableCell", children: $0.inlines.map(inline)) })
    })
  case .details(let summary, _, let body, _):
    return node("details", children: [node("paragraph", children: summary.map(inline))] + body.map(block))
  }
}

private func inline(_ value: MarkdownInlineFfi) -> Document {
  switch value {
  case .text(let content): return node("text", content)
  case .softBreak, .hardBreak: return node("text", "\n")
  case .code(let content): return node("code", content)
  case .math(let content): return node("math", content)
  case .emph(let children): return node("italic", children: children.map(inline))
  case .strong(let children): return node("bold", children: children.map(inline))
  case .strikethrough(let children): return node("strike", children: children.map(inline))
  case .link(let dest, _, let children, let classification): return link(dest, classification, children.map(inline))
  case .image(_, _, let alt, _): return node("paragraph", children: alt.map(inline))
  case .autolink(let url, let kind, let classification):
    let destination = kind == .www ? "https://\(url)" : kind == .email ? "mailto:\(url)" : url
    return link(destination, classification, [node("text", url)])
  case .nostrMention(let entity), .nostrUri(let entity): return node("nostr", entity.bech32)
  case .timestamp(let unixSeconds, let style):
    return adding(node("timestamp", String(unixSeconds)), "style", wireName(style))
  }
}

private func link(_ url: String, _ classification: MarkdownLinkDestinationKindFfi, _ children: [Document]) -> Document {
  let label = node("link", children: children)
  return classification == .web || classification == .contact ? adding(label, "destination", url) : label
}

private func node(_ kind: String, _ text: String? = nil, children: [Document]? = nil) -> Document {
  var result: Document = ["kind": kind]
  if let text { result["text"] = text }
  if let children { result["children"] = children }
  return result
}

private func adding(_ document: Document, _ field: String, _ value: Any) -> Document {
  var result = document
  result[field] = value
  return result
}
