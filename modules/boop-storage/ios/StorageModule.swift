import ExpoModulesCore
import Foundation

public final class StorageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BoopStorage")

    AsyncFunction("usage") { () throws -> [String: Any] in
      let fm = FileManager.default
      let root = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
      let keys: Set<URLResourceKey> = [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]
      var partial = false
      guard let files = fm.enumerator(at: root, includingPropertiesForKeys: Array(keys), errorHandler: { _, error in
        if (error as? CocoaError)?.code != .fileReadNoSuchFile { partial = true }
        return true
      }) else { throw CocoaError(.fileReadUnknown) }
      var sizes = [String: Double]()
      for case let file as URL in files {
        do {
          let attributes = try file.resourceValues(forKeys: keys)
          if attributes.isSymbolicLink == true {
            files.skipDescendants()
            continue
          }
          guard attributes.isRegularFile == true, let bytes = attributes.fileSize else { continue }
          let parts = file.pathComponents.dropFirst(root.pathComponents.count)
          let key: String
          if parts.starts(with: ["Documents", "avatar-cache"]) {
            key = "profileCache"
          } else if parts.starts(with: ["Documents", "avatar-local"]) {
            key = "profileLocal"
          } else if parts.starts(with: ["Library", "Caches", "link-previews"]), file.pathExtension != "bin" {
            key = "linkPreviews"
          } else if parts.starts(with: ["Library", "Application Support", "marmot"]) {
            key = "marmot"
          } else if parts.starts(with: ["Documents", "SQLite"]) {
            key = "database"
          } else {
            key = "other"
          }
          sizes[key, default: 0] += Double(bytes)
        } catch {
          if (error as? CocoaError)?.code != .fileReadNoSuchFile { partial = true }
        }
      }
      return ["files": sizes, "partial": partial]
    }.runOnQueue(.global(qos: .utility))
  }
}

