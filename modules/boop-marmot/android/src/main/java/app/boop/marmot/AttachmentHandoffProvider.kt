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
  private data class Entry(val account: String, val file: File, val name: String, val type: String)

  companion object {
    private val entries = ConcurrentHashMap<String, Entry>()

    internal fun register(account: String, lease: String, path: String, name: String, type: String) {
      entries[lease] = Entry(account, File(path), name, type)
    }

    internal fun uri(context: Context, account: String, lease: String): Pair<Uri, String>? {
      val entry = entries[lease]?.takeIf { it.account == account } ?: return null
      val uri = Uri.Builder().scheme("content")
        .authority("${context.packageName}.MarmotAttachmentHandoff")
        .appendPath(lease).appendPath(entry.name).build()
      return uri to entry.type
    }

    internal fun release(lease: String) { entries.remove(lease) }

    internal fun retire(account: String) { entries.entries.removeAll { it.value.account == account } }
  }

  private fun entry(uri: Uri): Entry {
    val segments = uri.pathSegments
    if (segments.size != 2) throw FileNotFoundException()
    return entries[segments[0]]?.takeIf { it.name == segments[1] }
      ?: throw FileNotFoundException()
  }

  override fun onCreate() = true
  override fun getType(uri: Uri): String? = runCatching { entry(uri).type }.getOrNull()

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException()
    return ParcelFileDescriptor.open(entry(uri).file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun query(
    uri: Uri, projection: Array<out String>?, selection: String?,
    selectionArgs: Array<out String>?, sortOrder: String?,
  ): Cursor {
    val entry = entry(uri)
    val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    return MatrixCursor(columns, 1).apply {
      addRow(columns.map { column ->
        when (column) {
          OpenableColumns.DISPLAY_NAME -> entry.name
          OpenableColumns.SIZE -> entry.file.length()
          else -> null
        }
      })
    }
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
}
