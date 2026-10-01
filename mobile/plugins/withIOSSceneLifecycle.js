/**
 * Expo config plugin: iOS UIScene lifecycle adoption.
 *
 * iOS 26+/27 requires apps to adopt the UIKit Scene lifecycle. Expo SDK 57 still
 * generates an AppDelegate that builds the window in didFinishLaunching and ships
 * no SceneDelegate, so UIKit traps at first scene creation
 * (__UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption) and the app dies
 * on launch with SIGTRAP. A debug build on the simulator only logs a runtime issue,
 * so this is invisible until a release build runs on a real iOS 26+ device.
 *
 * This plugin makes the fix survive `expo prebuild` by:
 *   1. Declaring UIApplicationSceneManifest in Info.plist (points at SceneDelegate).
 *   2. Writing ios/<project>/SceneDelegate.swift.
 *   3. Adding SceneDelegate.swift to the Xcode app target's compile sources.
 *
 * The window and React Native root are still created by AppDelegate.didFinishLaunching
 * (the default Expo template behaviour); the SceneDelegate simply adopts that window
 * into the connecting UIWindowScene rather than creating a second one.
 *
 * The same plugin as WardenOS and DockBit (both live in the App Store). Kova's one addition: home-screen quick
 * actions (expo-quick-actions). Under the scene life cycle iOS hands them to the scene, not the app delegate, so
 * the SceneDelegate passes them on to it, cold start included. Remove this plugin after moving to Expo SDK 58,
 * whose template adopts scenes itself.
 */
const { withInfoPlist, withXcodeProject, withDangerousMod, IOSConfig } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SCENE_DELEGATE_SWIFT = `import UIKit
import React

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }

    // The window (and React Native root) is created by AppDelegate.didFinishLaunching.
    // Adopt that existing window into this UIWindowScene so it is displayed, instead of
    // creating a second window.
    if let window = appDelegate.window {
      window.windowScene = windowScene
      self.window = window
      window.makeKeyAndVisible()
    }

    // A quick action that launched the app (Kova: All off, Away, Bedtime…).
    if let item = connectionOptions.shortcutItem {
      DispatchQueue.main.async {
        appDelegate.application(UIApplication.shared, performActionFor: item, completionHandler: { _ in })
      }
    }

    if let urlContext = connectionOptions.urlContexts.first {
      RCTLinkingManager.application(UIApplication.shared, open: urlContext.url, options: [:])
    } else if let userActivity = connectionOptions.userActivities.first(where: { $0.webpageURL != nil || $0.activityType != "" }) {
      RCTLinkingManager.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let url = URLContexts.first?.url else { return }
    RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  // A quick action while the app is running.
  func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return completionHandler(false) }
    appDelegate.application(UIApplication.shared, performActionFor: shortcutItem, completionHandler: completionHandler)
  }
}
`;

function withSceneManifest(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });
}

function withSceneDelegateFile(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SceneDelegate.swift'), SCENE_DELEGATE_SWIFT);
      return cfg;
    },
  ]);
}

function withSceneDelegateInTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const projectName = cfg.modRequest.projectName;
    const filepath = `${projectName}/SceneDelegate.swift`;
    if (!cfg.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: projectName,
        project: cfg.modResults,
      });
    }
    return cfg;
  });
}

module.exports = function withIOSSceneLifecycle(config) {
  config = withSceneManifest(config);
  config = withSceneDelegateFile(config);
  config = withSceneDelegateInTarget(config);
  return config;
};
