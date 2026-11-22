package app.boop.storage

import android.net.TrafficStats
import android.os.Process
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class StorageModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BoopStorage")

    AsyncFunction("usage").Coroutine<Map<String, Any>> {
      val context = appContext.reactContext ?: throw IOException("Storage unavailable")
      withContext(Dispatchers.IO) {
        val root = context.dataDir.toPath()
        val sizes = mutableMapOf<String, Long>()
        var partial = false
        Files.walkFileTree(root, object : SimpleFileVisitor<Path>() {
          override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
            if (!attrs.isRegularFile) return FileVisitResult.CONTINUE
            val path = root.relativize(file)
            val key = when {
              path.startsWith("files/avatar-cache") -> "profileCache"
              path.startsWith("files/avatar-local") -> "profileLocal"
              path.startsWith("cache/link-previews") && !file.fileName.toString().endsWith(".bin") -> "linkPreviews"
              path.startsWith("no_backup/marmot") -> "marmot"
              path.startsWith("files/SQLite") || path.startsWith("databases") -> "database"
              else -> "other"
            }
            sizes[key] = (sizes[key] ?: 0L) + attrs.size()
            return FileVisitResult.CONTINUE
          }

          override fun visitFileFailed(file: Path, error: IOException): FileVisitResult {
            if (error !is NoSuchFileException) partial = true
            return FileVisitResult.CONTINUE
          }

          override fun postVisitDirectory(dir: Path, error: IOException?): FileVisitResult {
            if (error != null && error !is NoSuchFileException) partial = true
            return FileVisitResult.CONTINUE
          }
        })

        val result = mutableMapOf<String, Any>(
          "files" to sizes.mapValues { it.value.toDouble() },
          "partial" to partial,
          "freeBytes" to context.dataDir.usableSpace.toDouble()
        )
        val uid = Process.myUid()
        val received = TrafficStats.getUidRxBytes(uid)
        val sent = TrafficStats.getUidTxBytes(uid)
        if (received >= 0 && sent >= 0) {
          result["traffic"] = mapOf("received" to received.toDouble(), "sent" to sent.toDouble())
        }
        result
      }
    }
  }
}
