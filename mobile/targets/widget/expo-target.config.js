// The iOS widget extension: home-screen and lock-screen widgets, and the Live Activity.
// Files in _shared/ are compiled into the app as well (the Siri intents and the hub client).
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = config => ({
  type: 'widget',
  // au.clickbit.kova.widget: the widgets, the lock-screen Live Activity and the Siri intents' extension.
  bundleIdentifier: '.widget',
  name: 'KovaWidgets',
  displayName: 'Kova',
  icon: '../../assets/images/icon.png',
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit', 'AppIntents'],
  colors: {
    $widgetBackground: '#0e0f10',
    $accent: '#f2b14c',
  },
  entitlements: {
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
});
