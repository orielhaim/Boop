sdk = 'sdk/marmotkit-ios-0.18.0-boop'
root = File.expand_path('../..', __dir__)
Dir.chdir(root) do
  raise 'Unable to prepare MarmotKit 0.18.0 for iOS' unless system('bun', 'scripts/fetch-marmotkit.ts', 'ios')
end

Pod::Spec.new do |s|
  s.name = 'BoopMarmot'
  s.version = '1.0.0'
  s.summary = 'Boop native Marmot messaging'
  s.license = { :type => 'GPL-3.0' }
  s.author = 'Boop'
  s.homepage = 'https://github.com/orielhaim/Boop'
  s.source = { :git => 'https://github.com/orielhaim/Boop.git' }
  s.platforms = { :ios => '18.0' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'ios/*.swift', "#{sdk}/MarmotKit.swift"
  s.vendored_frameworks = "#{sdk}/MarmotKit.xcframework"
  s.resource_bundles = { 'BoopMarmotPrivacy' => ["#{sdk}/PrivacyInfo.xcprivacy"] }
  s.frameworks = 'Security', 'SystemConfiguration'
end
