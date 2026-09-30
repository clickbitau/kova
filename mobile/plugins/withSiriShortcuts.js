// Adds ios-app/*.swift (the App Shortcuts provider for Siri) to the main app target.
// It has to live in the app itself, not in an extension, for Siri to offer its phrases.
const fs = require('fs');
const path = require('path');
const { withXcodeProject, IOSConfig } = require('expo/config-plugins');

module.exports = function withSiriShortcuts(config) {
  return withXcodeProject(config, cfg => {
    const project = cfg.modResults;
    const root = cfg.modRequest.projectRoot;
    const appName = cfg.modRequest.projectName;
    const src = path.join(root, 'ios-app');
    const dest = path.join(cfg.modRequest.platformProjectRoot, appName);
    for (const file of fs.readdirSync(src).filter(f => f.endsWith('.swift'))) {
      fs.copyFileSync(path.join(src, file), path.join(dest, file));
      const rel = `${appName}/${file}`;
      if (!project.hasFile(rel)) {
        IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath: rel, groupName: appName, project });
      }
    }
    return cfg;
  });
};
