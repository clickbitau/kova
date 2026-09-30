// Siri and the Shortcuts app: phrases that work without setting anything up.
// The intents themselves are in targets/widget/_shared (compiled into the app and the widget).

import AppIntents

struct KovaShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskKovaIntent(),
      phrases: ["Ask \(.applicationName)", "Tell \(.applicationName)", "Hey \(.applicationName)"],
      shortTitle: "Ask Kova",
      systemImageName: "waveform"
    )
    AppShortcut(
      intent: StartOverlayIntent(),
      phrases: ["Switch the home with \(.applicationName)", "Start a scene in \(.applicationName)"],
      shortTitle: "Switch the home",
      systemImageName: "sparkles"
    )
    AppShortcut(
      intent: LightsOffIntent(),
      phrases: ["Turn off the lights with \(.applicationName)", "\(.applicationName) lights off"],
      shortTitle: "All lights off",
      systemImageName: "lightbulb.slash"
    )
  }

  static var shortcutTileColor: ShortcutTileColor = .orange
}
