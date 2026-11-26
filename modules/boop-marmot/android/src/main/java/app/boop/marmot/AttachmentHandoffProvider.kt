package app.boop.marmot

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.ConcurrentHashMap

class AttachmentHandoffProvider : ContentProvider() {
  private data class Entry(val account: String, val generation: String, val file: File, val name: String, val type: String)

  companion object {
    private val entries = ConcurrentHashMap<String, Entry>()
    private val activeGenerations = ConcurrentHashMap<String, String>()
    private val lock = Any()

    internal fun activate(account: String, generation: String) = synchronized(lock) {
      activeGenerations[account] = generation
      entries.entries.removeAll { it.value.account == account && it.value.generation != generation }
    }

    internal fun register(account: String, generation: String, lease: String, path: String, name: String, type: String): Boolean = synchronized(lock) {
      if (activeGenerations[account] != generation) return@synchronized false
      entries[lease] = Entry(account, generation, File(path), name, type)
      true
    }

    internal fun uri(context: Context, account: String, generation: String, lease: String): Pair<Uri, String>? = synchronized(lock) {
      if (activeGenerations[account] != generation) return@synchronized null
      val entry = entries[lease]?.takeIf { it.account == account && it.generation == generation } ?: return@synchronized null
      val uri = Uri.Builder().scheme("content")
        .authority("${context.packageName}.MarmotAttachmentHandoff")
        .appendPath(lease).appendPath(entry.name).build()
      uri to entry.type
    }

    internal fun release(lease: String) { synchronized(lock) { entries.remove(lease) } }

    internal fun retire(account: String, generation: String? = null) = synchronized(lock) {
      val active = activeGenerations[account]
      if (active != null && (generation == null || active == generation)) activeGenerations.remove(account, active)
      entries.entries.removeAll { it.value.account == account && (generation == null || it.value.generation == generation) }
    }
  }

  private fun entry(uri: Uri): Entry {
    val segments = uri.pathSegments
    if (segments.size != 2) throw FileNotFoundException()
    return entries[segments[0]]?.takeIf {
      it.name == segments[1] && activeGenerations[it.account] == it.generation
    }
      ?: throw FileNotFoundException()
  }

  override fun onCreate() = true
  override fun getType(uri: Uri): String? = synchronized(lock) { runCatching { entry(uri).type }.getOrNull() }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException()
    return synchronized(lock) { ParcelFileDescriptor.open(entry(uri).file, ParcelFileDescriptor.MODE_READ_ONLY) }
  }

  override fun query(
    uri: Uri, projection: Array<out String>?, selection: String?,
    selectionArgs: Array<out String>?, sortOrder: String?,
  ): Cursor {
    return synchronized(lock) {
      val entry = entry(uri)
      val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
      MatrixCursor(columns, 1).apply {
        addRow(columns.map { column ->
          when (column) {
            OpenableColumns.DISPLAY_NAME -> entry.name
            OpenableColumns.SIZE -> entry.file.length()
            else -> null
          }
        })
      }
    }
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
}
