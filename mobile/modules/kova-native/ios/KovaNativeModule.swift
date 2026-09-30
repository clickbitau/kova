import ActivityKit
import ExpoModulesCore
import WidgetKit

// Must match targets/widget/LiveActivity.swift field for field: the widget draws what this starts.
struct KovaHomeAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var mode: String
    var modeColor: String
    var modeIcon: String
    var lightsOn: Int
    var since: Date
    var nextAt: Date?
    var nextLabel: String?
    var nextWhat: String?
    var nextId: String?
    var overlay: String?
  }

  var homeName: String
}

/** The home right now, from JS. Times are epoch milliseconds. */
struct HomeStateRecord: Record {
  @Field var mode: String = ""
  @Field var modeColor: String = "#f2b14c"
  @Field var modeIcon: String = "home"
  @Field var lightsOn: Int = 0
  @Field var since: Double = 0
  @Field var nextAt: Double? = nil
  @Field var nextLabel: String? = nil
  @Field var nextWhat: String? = nil
  @Field var nextId: String? = nil
  @Field var overlay: String? = nil

  var state: KovaHomeAttributes.ContentState {
    KovaHomeAttributes.ContentState(
      mode: mode, modeColor: modeColor, modeIcon: modeIcon, lightsOn: lightsOn,
      since: Date(timeIntervalSince1970: since / 1000),
      nextAt: nextAt.map { Date(timeIntervalSince1970: $0 / 1000) },
      nextLabel: nextLabel, nextWhat: nextWhat, nextId: nextId, overlay: overlay
    )
  }

  /** After the next change the activity is out of date until the app updates it; the system shows that. */
  var content: ActivityContent<KovaHomeAttributes.ContentState> {
    ActivityContent(state: state, staleDate: nextAt.map { Date(timeIntervalSince1970: $0 / 1000 + 120) })
  }
}

public class KovaNativeModule: Module {
  static let group = "group.au.clickbit.kova"

  public func definition() -> ModuleDefinition {
    Name("KovaNative")

    /** Share JSON with the widget extension (the hub's address and token, the latest snapshot). nil removes it. */
    Function("setShared") { (key: String, json: String?) in
      let defaults = UserDefaults(suiteName: KovaNativeModule.group)
      if let json = json { defaults?.set(json.data(using: .utf8), forKey: key) } else { defaults?.removeObject(forKey: key) }
    }

    Function("reloadWidgets") {
      WidgetCenter.shared.reloadAllTimelines()
    }

    Function("liveActivitiesEnabled") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    Function("activityRunning") { () -> Bool in
      !Activity<KovaHomeAttributes>.activities.isEmpty
    }

    AsyncFunction("startActivity") { (homeName: String, record: HomeStateRecord) async throws -> String in
      for old in Activity<KovaHomeAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
      let activity = try Activity.request(attributes: KovaHomeAttributes(homeName: homeName), content: record.content)
      return activity.id
    }

    AsyncFunction("updateActivity") { (record: HomeStateRecord) async in
      for activity in Activity<KovaHomeAttributes>.activities { await activity.update(record.content) }
    }

    AsyncFunction("endActivity") { () async in
      for activity in Activity<KovaHomeAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
    }
  }
}
