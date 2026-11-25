package app.boop.marmot

import dev.ipf.marmotkit.Marmot

internal fun reorderPinnedChats(kit: Marmot, account: String, visibleOrder: List<String>) {
  val current = kit.chatList(account, true).filter { it.pinned }.map { it.groupIdHex }
  val requested = visibleOrder.toSet()
  if (requested.size != visibleOrder.size) throw problem("InvalidPinOrder")
  val currentSet = current.toSet()
  val reordered = visibleOrder.filter { it in currentSet }.iterator()
  // Replace only the slots from this drop. Hidden pins and concurrent new pins keep their places.
  val merged = current.map { if (it in requested) reordered.next() else it }
  if (current != merged) kit.setPinnedChatOrder(account, merged)
}
