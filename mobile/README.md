# Kova for iPhone and Android

The native Kova app: Expo SDK 57 and React Native, like the Warden and Helix apps.
It talks to your home's Kova hub on your network; nothing goes through a cloud
except push notifications (Expo's push service relays them to Apple and Google).

## What's in it

- **Now, Devices, Ask, Security, More**: the phone design, drawn natively. Tiles
  switch things; ⋯ opens the device panel with every control, why it's like this,
  what's next, and its name, room, favourite and hidden settings.
- **Arrive and leave**: the phone watches a 150 m circle around the home and tells
  the hub when you cross it, even with the app closed (More → This phone).
- **Notifications**: the doorbell (tap to see the camera), everyone out with lights
  on (*Turn them off*), the internet dropping (Warden).
- Setup screens (Integrations, Customise, the mode editor, Energy, Media, Add a
  device) and live camera video open the hub's own page inside the app.
- **Widgets**: *Home* (the mode, what's next, lights on; home screen and lock
  screen) and *Favourites* (tap a device to switch it) on iPhone; one widget with
  the mode and four favourites on Android.
- **Lock screen** (iPhone): your home as a Live Activity and in the Dynamic
  Island, with *Skip* for the next change (More → This phone).
- **Siri**: “Ask Kova” (then say anything you'd type in Ask), “Switch the home
  with Kova”, “Turn off the lights with Kova”. They're in the Shortcuts app too.
- **Quick actions**: long-press the app icon for scenes, all lights off and Ask.

## Connecting

1. On a computer, open Kova and choose **Kova on your phone** in the sidebar (or,
   in the phone web app, More → Kova app on your phone). It shows a QR code with
   the hub's address and token.
2. In the app, tap **Scan the code**. Or **Find my hub on this Wi-Fi**, or type
   the address (and the token, if the hub has `KOVA_TOKEN`).

## Running it

```bash
npm install
npx expo run:ios        # or run:android; a development build, on a phone or simulator
npm run typecheck && npm test
```

Background location (arrive and leave), push notifications, widgets, the Live
Activity and Siri need a development or store build (`npx expo run:ios`); Expo Go
has none of them.

**iOS extras** need two things in `app.json` before the first build: your
`ios.appleTeamId` (Xcode → Signing & Capabilities), and the App Group
`group.au.clickbit.kova` registered for your team (Xcode does this when you build
with automatic signing). The iPhone app needs iOS 17 or later. The widget and
Siri code is in `targets/widget/` (shared with the app through `_shared/`) and
`ios-app/`; `modules/kova-native` is the small native module the app uses to
share the hub with the widget and run the Live Activity.

**Push notifications** need an Expo project id: run `npx eas init` (it adds
`extra.eas.projectId` to `app.json`) and build with EAS. Without one, the app
says so on the This phone screen and everything else works.

**Icons** are Material Symbols Rounded, cut to the icons the app uses
(`assets/fonts/KovaSymbols*.ttf`, outlined and filled). To add one, put its name
in `scripts/icons.txt` and run `scripts/build-icons.py` (see the top of that file).

**The web build** (`npm run export:web`) is for checking screens in a browser;
serve it from the hub's origin, since the hub's API doesn't allow other origins.
