# Room ACs with Google Home, Alexa and Apple Home

A ducted air conditioner serves the whole home, and Google Home (through the maker's own integration) only
sees one AC with a mode and a fan. Kova knows the zones and the rooms they serve, so it publishes **one AC per
room**: "Lounge AC", "Office AC", and so on. Ask a speaker to turn on the AC, and only that room's zone opens.

## Before you start

- The AC's zones have rooms: open the AC in Kova (Devices → Whole home), and choose the rooms each zone serves.
- The **Matter bridge** is on (Integrations → Matter bridge) for Google Home, Alexa and SmartThings, and/or the
  **Apple Home bridge** for the Home app and Siri. Settings → Voice and other apps shows both, with their codes.
  The Matter bridge uses Matter's test vendor id: Google Home only accepts it on an account that registered that
  vendor and product id in the Google Home Developer Console (Apple Home and SmartThings warn and carry on).

## Once, in Google Home

1. **Add Kova**: Devices → Add → Matter-enabled device, and scan the Matter bridge's QR code (or type its code)
   from Settings → Voice and other apps.
2. **Put each room AC in its room**, the room whose speaker should control it: "Lounge AC" in the Lounge.
3. Say **"Hey Google, turn on the AC"** in that room. Google knows which room each speaker is in and sends the
   request to the AC in that room. That's how Kova knows which speaker asked.

Alexa (Matter) and Apple Home (the Home app's room for each AC) work the same way.

## What "turn on the AC" does

- The room's zone opens. If the AC is off, Kova turns it on for that room: cooling when the room is warm or it's
  summer, heating when the room is cold or it's winter (the season for your hemisphere, from the home's
  location), and in spring and autumn by the room and the forecast. It cools to 24° and heats to 21°, unless
  you change those in Settings → Voice and other apps. The fan is on auto. Zones left open while the AC was off
  close, so only the room that asked gets air.
- If the AC is already running for other rooms, it keeps its mode and temperature: one room never changes
  another room's mode.
- "Turn off the AC" closes that room's zone. The AC turns off when no zone is left open.
- "Set the AC to 22", "cool mode", "set the fan to high": done as you say. Your choice holds until that room's
  AC is turned off, and comes back the next time you turn it on this season. The AC has one set temperature, so
  it applies to every room that's on.
- A zone that serves two rooms gives each room its own AC; turning either off closes the shared zone.

## Two ACs in Google Home

If the AC maker's app (ConnectLife, for example) is also linked in Google Home, Google shows its own whole-home
AC next to Kova's room ACs, with only mode and fan. "Turn on the AC" may reach that one, and no zone opens. In
Google Home, either unlink the maker (Settings → Works with Google → the maker → Unlink), or rename its AC (say
"Whole house AC") and leave it out of rooms that have speakers. Kova never changes anything in Google Home.

Optionally, Kova can step in when the AC is turned on from another app with every zone closed: Settings → Voice
and other apps → **Turned on from another app** opens the zones of rooms where someone is right now (motion,
a person seen, a TV on or music playing there), keeping the mode it was turned on in, and asks on your phones
when nobody is anywhere. It's off by default: Kova can't know which speaker asked the maker's integration, so
it's a best guess.

## Ask Kova

"Turn on the AC in the lounge" works the same way. "Turn on the AC in here" asks which room, because the app
doesn't know which room it's in yet.
