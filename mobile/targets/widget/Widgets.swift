// Kova's home-screen and lock-screen widgets, and the Live Activity. They read the hub directly
// (the app shares its address and token through the App Group) and fall back to the last
// snapshot when the phone is away from home.

import AppIntents
import SwiftUI
import WidgetKit

@main
struct KovaWidgets: WidgetBundle {
  var body: some Widget {
    HomeWidget()
    FavouritesWidget()
    HomeLiveActivity()
  }
}

// MARK: - Colours (docs/design/tokens)

extension Color {
  init(hex: String) {
    let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    let n = UInt64(h, radix: 16) ?? 0xf2b14c
    self.init(red: Double((n >> 16) & 255) / 255, green: Double((n >> 8) & 255) / 255, blue: Double(n & 255) / 255)
  }
  static let kPage = Color(hex: "#0e0f10")
  static let kCard = Color(hex: "#16171a")
  static let kControl = Color(hex: "#232428")
  static let kBone = Color(hex: "#f1efea")
  static let kStone = Color(hex: "#a3a09a")
  static let kAmber = Color(hex: "#f2b14c")
  static let kOnAmber = Color(hex: "#1a1408")
  static let kBlue = Color(hex: "#7cb8f0")
}

/** The Kova mark: the roof, the smaller roof, the amber dot. */
struct KovaMark: View {
  var size: CGFloat = 18
  var body: some View {
    Canvas { ctx, s in
      let k = s.width / 48
      var big = Path(); big.move(to: CGPoint(x: 8 * k, y: 26 * k)); big.addLine(to: CGPoint(x: 24 * k, y: 11 * k)); big.addLine(to: CGPoint(x: 40 * k, y: 26 * k))
      var small = Path(); small.move(to: CGPoint(x: 16 * k, y: 32 * k)); small.addLine(to: CGPoint(x: 24 * k, y: 24.5 * k)); small.addLine(to: CGPoint(x: 32 * k, y: 32 * k))
      let stroke = StrokeStyle(lineWidth: 5 * k, lineCap: .round, lineJoin: .round)
      ctx.stroke(big, with: .color(.kBone), style: stroke)
      ctx.stroke(small, with: .color(.kBone), style: stroke)
      ctx.fill(Path(ellipseIn: CGRect(x: 20.5 * k, y: 35 * k, width: 7 * k, height: 7 * k)), with: .color(.kAmber))
    }
    .frame(width: size, height: size)
  }
}

// MARK: - Timeline

struct HomeEntry: TimelineEntry {
  let date: Date
  let snap: KovaSnapshot?
  /** True when this came from the cache because the hub didn't answer. */
  let stale: Bool
}

struct HomeProvider: TimelineProvider {
  func placeholder(in context: Context) -> HomeEntry { HomeEntry(date: .now, snap: KovaGroup.cachedSnapshot, stale: false) }

  func getSnapshot(in context: Context, completion: @escaping (HomeEntry) -> Void) {
    completion(HomeEntry(date: .now, snap: KovaGroup.cachedSnapshot, stale: false))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<HomeEntry>) -> Void) {
    Task {
      let live = try? await KovaClient.request("GET", "/api/state", timeout: 6)
      var snap: KovaSnapshot? = nil
      if let live, let s = try? JSONDecoder().decode(KovaSnapshot.self, from: live) { KovaGroup.cache(live); snap = s }
      let entry = HomeEntry(date: .now, snap: snap ?? KovaGroup.cachedSnapshot, stale: snap == nil)
      // WidgetKit budgets refreshes; the app and widget buttons also reload after every change.
      completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
    }
  }
}

// MARK: - Home: the mode, what's next, lights on

struct HomeWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "KovaHome", provider: HomeProvider()) { entry in
      HomeWidgetView(entry: entry)
        .containerBackground(Color.kPage, for: .widget)
        .widgetURL(URL(string: "kova://now"))
    }
    .configurationDisplayName("Home")
    .description("The mode your home is in, what’s next, and how many lights are on.")
    .supportedFamilies([.systemSmall, .accessoryRectangular, .accessoryInline, .accessoryCircular])
  }
}

struct HomeWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: HomeEntry

  var body: some View {
    if let snap = entry.snap, let mode = snap.mode {
      switch family {
      case .accessoryInline:
        Label("\(mode.name) · \(snap.lightsOn) on", systemImage: KovaIcon.sf(mode.icon))
      case .accessoryCircular:
        VStack(spacing: 1) {
          Image(systemName: KovaIcon.sf(mode.icon)).font(.system(size: 16, weight: .semibold))
          Text("\(snap.lightsOn)").font(.system(size: 13, weight: .bold))
        }
      case .accessoryRectangular:
        VStack(alignment: .leading, spacing: 1) {
          Label(mode.name, systemImage: KovaIcon.sf(mode.icon)).font(.headline)
          Text("\(snap.lightsOn) light\(snap.lightsOn == 1 ? "" : "s") on").font(.caption)
          if let until = snap.current.untilLabel, let next = snap.nextMode { Text("\(until) \(next.name)").font(.caption2).foregroundStyle(.secondary) }
        }
      default:
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            KovaMark(size: 16)
            Text(snap.home.name).font(.system(size: 11, weight: .bold)).foregroundStyle(Color.kStone).lineLimit(1)
          }
          Spacer(minLength: 0)
          Image(systemName: KovaIcon.sf(mode.icon)).font(.system(size: 22, weight: .semibold)).foregroundStyle(Color(hex: mode.color))
          Text(mode.name).font(.system(size: 24, weight: .bold)).foregroundStyle(Color.kBone).lineLimit(1).minimumScaleFactor(0.7)
          if let until = snap.current.untilLabel, let next = snap.nextMode {
            Text("Until \(until), then \(next.name)").font(.system(size: 11)).foregroundStyle(Color.kStone).lineLimit(2)
          }
          Text(entry.stale ? "Away from home" : "\(snap.lightsOn) light\(snap.lightsOn == 1 ? "" : "s") on")
            .font(.system(size: 11, weight: .semibold)).foregroundStyle(entry.stale ? Color.kStone : Color.kAmber)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      }
    } else {
      VStack(alignment: .leading, spacing: 6) {
        KovaMark(size: 22)
        Text("Open Kova to connect it to your home.").font(.system(size: 12)).foregroundStyle(Color.kStone)
      }
    }
  }
}

// MARK: - Favourites: tap to switch, without opening the app

struct FavouritesWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "KovaFavourites", provider: HomeProvider()) { entry in
      FavouritesView(entry: entry)
        .containerBackground(Color.kPage, for: .widget)
    }
    .configurationDisplayName("Favourites")
    .description("Your favourite devices. Tap one to switch it.")
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}

struct FavouritesView: View {
  @Environment(\.widgetFamily) var family
  let entry: HomeEntry

  var body: some View {
    if let snap = entry.snap {
      let count = family == .systemLarge ? 8 : 4
      let items = Array(snap.favouriteDevices.prefix(count))
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 6) {
          KovaMark(size: 14)
          if let mode = snap.mode {
            Text(mode.name).font(.system(size: 12, weight: .bold)).foregroundStyle(Color(hex: mode.color))
          }
          Text("· \(snap.lightsOn) on").font(.system(size: 12)).foregroundStyle(Color.kStone)
          Spacer()
          if entry.stale { Image(systemName: "wifi.slash").font(.system(size: 11)).foregroundStyle(Color.kStone) }
        }
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
          ForEach(items, id: \.id) { d in
            Button(intent: ToggleDeviceIntent(deviceId: d.id)) { FavouriteTile(device: d) }
              .buttonStyle(.plain)
          }
        }
        Spacer(minLength: 0)
      }
    } else {
      Text("Open Kova to connect it to your home.").font(.system(size: 13)).foregroundStyle(Color.kStone)
    }
  }
}

struct FavouriteTile: View {
  let device: KovaSnapshot.Device

  var body: some View {
    let on = device.state.on == true
    let media = device.type == "media" || device.type == "tv"
    let accent = media ? Color.kBlue : Color.kAmber
    HStack(spacing: 8) {
      ZStack {
        Circle().fill(on ? accent : Color.kControl)
        Image(systemName: KovaIcon.device(device.type)).font(.system(size: 12, weight: .semibold))
          .foregroundStyle(on ? (media ? Color.kPage : Color.kOnAmber) : Color.kStone)
      }
      .frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 1) {
        Text(device.name).font(.system(size: 12, weight: .bold)).foregroundStyle(Color.kBone).lineLimit(1)
        Text(status).font(.system(size: 10)).foregroundStyle(on ? accent : Color.kStone).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(8)
    .frame(maxWidth: .infinity)
    .background(RoundedRectangle(cornerRadius: 12).fill(on ? accent.opacity(0.13) : Color.kCard))
  }

  var status: String {
    let s = device.state
    if s.online == false { return "Not responding" }
    if device.type == "media" || device.type == "tv" { return s.on == true ? (s.paused == true ? "Paused" : (s.media ?? "Playing")) : "Idle" }
    if device.type == "internet" { return s.on == true ? "Internet on" : "Paused" }
    guard s.on == true else { return "Off" }
    if device.type == "dimmer", let b = s.bri { return "On · \(Int(b))%" }
    return "On"
  }
}
