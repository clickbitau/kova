// Shared by the Kova app and its widget extension: where the hub is, a small client for it,
// the parts of its snapshot the widgets show, and the App Intents that Siri, Shortcuts,
// widget buttons and the Live Activity run. The app writes the hub's address and token and
// the latest snapshot into the App Group (see modules/kova-native); everything here reads them.

import AppIntents
import Foundation
import WidgetKit

enum KovaGroup {
  static let id = "group.au.clickbit.kova"
  static var defaults: UserDefaults? { UserDefaults(suiteName: id) }

  struct Hub: Codable {
    var url: String
    var token: String?
  }

  static var hub: Hub? {
    guard let data = defaults?.data(forKey: "hub") else { return nil }
    return try? JSONDecoder().decode(Hub.self, from: data)
  }

  /** The last snapshot the app or a widget saw, for when the hub can't be reached (away from home). */
  static var cachedSnapshot: KovaSnapshot? {
    guard let data = defaults?.data(forKey: "snapshot") else { return nil }
    return try? JSONDecoder().decode(KovaSnapshot.self, from: data)
  }

  static func cache(_ data: Data) {
    defaults?.set(data, forKey: "snapshot")
  }
}

// MARK: - The snapshot (GET /api/state), as far as widgets and Siri use it

struct KovaSnapshot: Codable {
  struct Home: Codable { var name: String; var clock: String? }
  struct Mode: Codable { var id: String; var name: String; var color: String; var icon: String }
  struct Overlay: Codable { var id: String; var name: String; var icon: String; var endsLabel: String? }
  struct Current: Codable {
    var modeId: String
    var untilLabel: String?
    var nextId: String?
    var overlay: Overlay?
  }
  struct State: Codable {
    var on: Bool?
    var bri: Double?
    var media: String?
    var paused: Bool?
    var online: Bool?
  }
  struct Device: Codable {
    var id: String
    var name: String
    var room: String
    var type: String
    var capabilities: [String]?
    var hidden: Bool?
    var state: State
  }
  struct Upcoming: Codable { var id: String; var t: String; var label: String; var what: String; var modeId: String?; var skipped: Bool? }

  var home: Home
  var current: Current
  var modes: [Mode]
  var devices: [Device]
  var favourites: [String]?
  var upcoming: [Upcoming]?
  var overlays: [Overlay]?

  var mode: Mode? { modes.first { $0.id == current.modeId } }
  var nextMode: Mode? { modes.first { $0.id == current.nextId } }
  var lightsOn: Int { devices.filter { ($0.type == "light" || $0.type == "dimmer") && $0.state.on == true }.count }

  /** The owner's favourites, or the first visible lights and plugs (the same rule as the app). */
  var favouriteDevices: [Device] {
    if let ids = favourites {
      return ids.compactMap { id in devices.first { $0.id == id } }
    }
    return Array(devices.filter { $0.hidden != true && ["light", "dimmer", "plug"].contains($0.type) }.prefix(8))
  }
}

// MARK: - Talking to the hub

enum KovaError: Error, CustomLocalizedStringResourceConvertible {
  case notConnected
  case hub(String)

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .notConnected: return "Open Kova and connect it to your home first."
    case .hub(let message): return "\(message)"
    }
  }
}

enum KovaClient {
  static func request(_ method: String, _ path: String, body: [String: Any]? = nil, timeout: TimeInterval = 8) async throws -> Data {
    guard let hub = KovaGroup.hub, let url = URL(string: hub.url + path) else { throw KovaError.notConnected }
    var req = URLRequest(url: url, timeoutInterval: timeout)
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    if let token = hub.token, !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body = body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, response) = try await URLSession.shared.data(for: req)
    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
      let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      throw KovaError.hub(message ?? "Your Kova hub said HTTP \(http.statusCode).")
    }
    return data
  }

  /** The live snapshot, cached for later; the cached one when the hub can't be reached. */
  static func snapshot() async -> KovaSnapshot? {
    if let data = try? await request("GET", "/api/state"), let snap = try? JSONDecoder().decode(KovaSnapshot.self, from: data) {
      KovaGroup.cache(data)
      return snap
    }
    return KovaGroup.cachedSnapshot
  }

  static func post(_ path: String, _ body: [String: Any] = [:]) async throws -> [String: Any] {
    let data = try await request("POST", path, body: body)
    return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }

  /** What tapping a device does: the same rule as the app's tiles. */
  static func toggleCommand(_ d: KovaSnapshot.Device) -> [String: Any] {
    let on = d.state.on == true
    if d.type == "fan" { return ["on": !on] }
    if d.capabilities?.contains("library") == true { return on ? ["paused": !(d.state.paused ?? false)] : ["on": true] }
    if d.type == "media" || d.type == "tv" { return on ? ["on": false, "media": NSNull()] : ["on": true] }
    return ["on": !on]
  }
}

// MARK: - Overlays as something Siri and Shortcuts can pick

struct OverlayEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Home scene"
  static var defaultQuery = OverlayQuery()

  var id: String
  var name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct OverlayQuery: EntityQuery {
  func entities(for identifiers: [OverlayEntity.ID]) async throws -> [OverlayEntity] {
    try await suggestedEntities().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [OverlayEntity] {
    guard let snap = await KovaClient.snapshot() else { throw KovaError.notConnected }
    return (snap.overlays ?? []).map { OverlayEntity(id: $0.id, name: $0.name) }
  }
}

// MARK: - Intents

/** "Ask Kova": Kova's own assistant on the hub answers (built in, nothing leaves the home unless you turned on AI). */
struct AskKovaIntent: AppIntent {
  static var title: LocalizedStringResource = "Ask Kova"
  static var description = IntentDescription("Ask or tell Kova something, like “turn off the kitchen” or “who’s home?”.")

  @Parameter(title: "Request", requestValueDialog: "What should Kova do?")
  var request: String

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let reply = try await KovaClient.post("/api/ask", ["text": request])
    let text = reply["text"] as? String ?? "Done."
    WidgetCenter.shared.reloadAllTimelines()
    return .result(dialog: "\(text)")
  }
}

/** Start one of the home's scenes (Movie, Away, Good night…). */
struct StartOverlayIntent: AppIntent {
  static var title: LocalizedStringResource = "Switch the home"
  static var description = IntentDescription("Start a scene such as Movie, Away or Good night.")

  @Parameter(title: "Scene")
  var overlay: OverlayEntity

  init() {}
  init(overlay: OverlayEntity) { self.overlay = overlay }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    _ = try await KovaClient.post("/api/overlays/\(overlay.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? overlay.id)/start")
    WidgetCenter.shared.reloadAllTimelines()
    return .result(dialog: "\(overlay.name) is on.")
  }
}

/** Every light off. */
struct LightsOffIntent: AppIntent {
  static var title: LocalizedStringResource = "Turn off all the lights"

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let r = try await KovaClient.post("/api/lights/off")
    let n = (r["changed"] as? [Any])?.count ?? 0
    WidgetCenter.shared.reloadAllTimelines()
    return .result(dialog: n == 0 ? "The lights were already off." : "Turned off \(n) light\(n == 1 ? "" : "s").")
  }
}

/** A widget button: switch one device, the way tapping its tile in the app does. */
struct ToggleDeviceIntent: AppIntent {
  static var title: LocalizedStringResource = "Switch a device"
  static var isDiscoverable = false

  @Parameter(title: "Device")
  var deviceId: String

  init() {}
  init(deviceId: String) { self.deviceId = deviceId }

  func perform() async throws -> some IntentResult {
    guard let snap = await KovaClient.snapshot(), let d = snap.devices.first(where: { $0.id == deviceId }) else { throw KovaError.notConnected }
    _ = try await KovaClient.post("/api/devices/\(deviceId)", KovaClient.toggleCommand(d))
    _ = await KovaClient.snapshot()
    WidgetCenter.shared.reloadAllTimelines()
    return .result()
  }
}

/** The Live Activity's "Skip": skip tonight's next change. Runs in the app, so it can update the activity. */
struct SkipNextIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Skip the next change"
  static var isDiscoverable = false

  @Parameter(title: "Item")
  var itemId: String

  init() {}
  init(itemId: String) { self.itemId = itemId }

  func perform() async throws -> some IntentResult {
    _ = try await KovaClient.post("/api/plan/skip", ["id": itemId, "skip": true])
    WidgetCenter.shared.reloadAllTimelines()
    return .result()
  }
}

// MARK: - Look

/** Material Symbols names the hub uses → SF Symbols. */
enum KovaIcon {
  static func sf(_ name: String) -> String {
    switch name {
    case "light_mode", "wb_sunny", "sunny": return "sun.max.fill"
    case "wb_twilight": return "sun.haze.fill"
    case "bedtime", "nights_stay", "dark_mode": return "moon.stars.fill"
    case "movie": return "film.fill"
    case "favorite": return "heart.fill"
    case "celebration": return "party.popper.fill"
    case "flight_takeoff", "luggage": return "airplane"
    case "group": return "person.2.fill"
    case "menu_book": return "book.fill"
    default: return "house.fill"
    }
  }

  static func device(_ type: String) -> String {
    switch type {
    case "light", "dimmer": return "lightbulb.fill"
    case "media": return "hifispeaker.fill"
    case "tv": return "tv.fill"
    case "fan": return "fan.fill"
    case "plug": return "powerplug.fill"
    case "camera": return "video.fill"
    case "vacuum": return "circle.circle.fill"
    case "internet": return "wifi"
    default: return "sensor.fill"
    }
  }
}
