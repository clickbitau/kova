// The home on the lock screen and in the Dynamic Island, as in the phone design's lock screen:
// the mode and lights on, the next change with a progress bar, and Skip.
// The app starts and updates it (modules/kova-native, which declares the same attributes).

import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct KovaHomeAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var mode: String
    var modeColor: String
    var modeIcon: String
    var lightsOn: Int
    /** When this mode began and when the next change is, for the progress bar. */
    var since: Date
    var nextAt: Date?
    var nextLabel: String?
    var nextWhat: String?
    var nextId: String?
    var overlay: String?
  }

  var homeName: String
}

struct HomeLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: KovaHomeAttributes.self) { context in
      LockScreenView(state: context.state, home: context.attributes.homeName)
        .activityBackgroundTint(Color(hex: "#1c1d20").opacity(0.88))
        .activitySystemActionForegroundColor(Color.kBone)
        .widgetURL(URL(string: "kova://now"))
    } dynamicIsland: { context in
      let s = context.state
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Label {
            Text(s.mode).font(.system(size: 15, weight: .bold))
          } icon: {
            Image(systemName: KovaIcon.sf(s.modeIcon)).foregroundStyle(Color(hex: s.modeColor))
          }
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text("\(s.lightsOn) on").font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.kAmber)
        }
        DynamicIslandExpandedRegion(.bottom) {
          NextRow(state: s, compact: true)
        }
      } compactLeading: {
        Image(systemName: KovaIcon.sf(s.modeIcon)).foregroundStyle(Color(hex: s.modeColor))
      } compactTrailing: {
        Text("\(s.lightsOn)").foregroundStyle(Color.kAmber)
      } minimal: {
        Image(systemName: KovaIcon.sf(s.modeIcon)).foregroundStyle(Color(hex: s.modeColor))
      }
      .widgetURL(URL(string: "kova://now"))
      .keylineTint(Color(hex: s.modeColor))
    }
  }
}

struct LockScreenView: View {
  let state: KovaHomeAttributes.ContentState
  let home: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        ZStack {
          RoundedRectangle(cornerRadius: 9).fill(Color(hex: "#111214"))
          KovaMark(size: 20)
        }
        .frame(width: 32, height: 32)
        VStack(alignment: .leading, spacing: 1) {
          Text("\(state.overlay ?? state.mode) · \(state.lightsOn) light\(state.lightsOn == 1 ? "" : "s") on")
            .font(.system(size: 15, weight: .bold)).foregroundStyle(Color.kBone)
          Text(home).font(.system(size: 12)).foregroundStyle(Color.kStone)
        }
        Spacer()
        Image(systemName: KovaIcon.sf(state.modeIcon)).font(.system(size: 18, weight: .semibold)).foregroundStyle(Color(hex: state.modeColor))
      }
      NextRow(state: state, compact: false)
    }
    .padding(16)
  }
}

struct NextRow: View {
  let state: KovaHomeAttributes.ContentState
  let compact: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let label = state.nextLabel {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.kBone).lineLimit(1)
            if let what = state.nextWhat, !compact { Text(what).font(.system(size: 12)).foregroundStyle(Color.kStone).lineLimit(1) }
          }
          Spacer()
          if let id = state.nextId {
            Button(intent: SkipNextIntent(itemId: id)) {
              Text("Skip").font(.system(size: 12, weight: .bold)).padding(.horizontal, 10).padding(.vertical, 5)
                .background(Capsule().fill(Color.white.opacity(0.1)))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.kBone)
          }
        }
      }
      if let next = state.nextAt, next > state.since {
        ProgressView(timerInterval: state.since...next, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
          .tint(Color(hex: state.modeColor))
      }
    }
  }
}
