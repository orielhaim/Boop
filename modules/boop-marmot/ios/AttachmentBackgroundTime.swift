import UIKit

@MainActor
final class AttachmentBackgroundTime {
  private var identifier: UIBackgroundTaskIdentifier = .invalid

  init() {
    identifier = UIApplication.shared.beginBackgroundTask(withName: "Boop attachment download") { [weak self] in
      Task { @MainActor in self?.end() }
    }
  }

  func end() {
    guard identifier != .invalid else { return }
    UIApplication.shared.endBackgroundTask(identifier)
    identifier = .invalid
  }
}
