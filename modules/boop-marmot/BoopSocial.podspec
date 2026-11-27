sdk = 'sdk/boop-social-ios'
root = File.expand_path('../..', __dir__)
Dir.chdir(root) do
  raise 'Unable to prepare Boop Social' unless system(
    'bun', 'packages/boop-social/scripts/build-native.ts', 'ios', File.join(__dir__, sdk)
  )
end

Pod::Spec.new do |s|
  s.name = 'BoopSocial'
  s.version = '0.1.0'
  s.summary = 'Boop Social native bindings'
  s.license = { :type => 'GPL-3.0' }
  s.author = 'Boop'
  s.homepage = 'https://github.com/orielhaim/Boop'
  s.source = { :git => 'https://github.com/orielhaim/Boop.git' }
  s.platforms = { :ios => '18.0' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.source_files = "#{sdk}/BoopSocial.swift"
  s.vendored_frameworks = "#{sdk}/BoopSocialFFI.xcframework"
end
