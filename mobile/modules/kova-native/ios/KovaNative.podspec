Pod::Spec.new do |s|
  s.name           = 'KovaNative'
  s.version        = '0.1.0'
  s.summary        = 'Kova: widgets, the Live Activity and the App Group'
  s.description    = 'Shares the hub with the widget extension, reloads widgets, and runs the home Live Activity.'
  s.license        = 'MIT'
  s.author         = 'Kova'
  s.homepage       = 'https://github.com/clickbitau/kova'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/clickbitau/kova.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'ActivityKit', 'WidgetKit'
  s.source_files   = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
