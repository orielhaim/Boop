import Foundation
import Security

enum SocialStorageKey {
  private static let service = "app.boop.social.storage.v1"
  private static let keySize = 32

  static func load(account: String) throws -> Data {
    var query = try accountQuery(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &value)
    if status == errSecSuccess {
      guard let key = value as? Data, key.count == keySize else {
        throw Failure.invalidKey
      }
      return key
    }
    guard status == errSecItemNotFound else { throw Failure.keychain(status) }

    var key = Data(count: keySize)
    let generated = key.withUnsafeMutableBytes { bytes in
      SecRandomCopyBytes(kSecRandomDefault, keySize, bytes.baseAddress!)
    }
    guard generated == errSecSuccess else { throw Failure.keychain(generated) }
    var item = try accountQuery(account)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    item[kSecValueData as String] = key
    let inserted = SecItemAdd(item as CFDictionary, nil)
    if inserted == errSecDuplicateItem {
      key.resetBytes(in: 0..<keySize)
      return try load(account: account)
    }
    guard inserted == errSecSuccess else {
      key.resetBytes(in: 0..<keySize)
      throw Failure.keychain(inserted)
    }
    return key
  }

  static func remove(account: String) throws {
    let status = SecItemDelete(try accountQuery(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw Failure.keychain(status)
    }
  }

  private static func accountQuery(_ account: String) throws -> [String: Any] {
    guard account.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw Failure.invalidKey
    }
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
    ]
  }

  private enum Failure: Error {
    case invalidKey
    case keychain(OSStatus)
  }
}
