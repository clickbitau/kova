// The widget extension's version and build number follow the app's: App Store Connect warns (and refuses on
// submission) when an extension's CFBundleVersion differs from its app's. The extension's Info.plist reads them
// from its build settings, and this copies the app target's MARKETING_VERSION and CURRENT_PROJECT_VERSION into the
// extension's, so whatever sets the app's build number (EAS remote versioning, agvtool -all) carries both.
const { withXcodeProject } = require('expo/config-plugins');

const WIDGET = 'KovaWidgets';

module.exports = function withWidgetVersion(config) {
  return withXcodeProject(config, cfg => {
    const project = cfg.modResults;
    const configs = project.pbxXCBuildConfigurationSection();
    const targets = project.pbxNativeTargetSection();
    const listOf = name => Object.values(targets).find(t => t && t.name && t.name.replace(/"/g, '') === name)?.buildConfigurationList;
    const settingsOf = listId => (project.pbxXCConfigurationList()[listId]?.buildConfigurations ?? []).map(c => configs[c.value]?.buildSettings).filter(Boolean);
    const app = listOf(cfg.modRequest.projectName), widget = listOf(WIDGET);
    if (!app || !widget) return cfg;
    const appSettings = settingsOf(app)[0] ?? {};
    const version = config.version ?? appSettings.MARKETING_VERSION ?? '1.0';
    const build = config.ios?.buildNumber ?? appSettings.CURRENT_PROJECT_VERSION ?? '1';
    for (const s of settingsOf(widget)) {
      s.MARKETING_VERSION = version;
      s.CURRENT_PROJECT_VERSION = build;
    }
    return cfg;
  });
};
