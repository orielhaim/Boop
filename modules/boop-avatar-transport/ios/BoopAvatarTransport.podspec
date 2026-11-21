Pod::Spec.new do |s|
  s.name           = 'BoopAvatarTransport'
  s.version        = '1.0.0'
  s.summary        = 'Boop HTTPS avatar downloads'
  s.description    = 'Direct, limited HTTPS downloads for public profile images.'
  s.license        = { :type => 'MIT' }
  s.author         = 'Boop'
  s.homepage       = 'https://github.com/orielhaim/Boop'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/orielhaim/Boop.git' }
  s.source_files   = '*.swift'
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network', 'ImageIO', 'CryptoKit', 'UniformTypeIdentifiers'
end
