# Kova privacy policy

> **Draft for the owner.** It was written from what the Kova app and hub actually do in this repository
> (October 2026, app 0.2.24, hub 0.7.x). Items marked **TO CONFIRM** need a decision or a fact from
> ClickBIT before this is published at <https://clickbit.com.au/privacy/kova>. The app links to that
> address, which is set in one place: `mobile/src/logic/links.ts` (`PRIVACY_POLICY_URL`).

_Last updated: **TO CONFIRM** (the date this is published)_

## Who we are

Kova is a smart-home hub and phone app made by ClickBIT (**TO CONFIRM**: the legal entity name, ABN and
postal address). In this policy, "we" means ClickBIT and "you" means the person using Kova.

## The short version

- **Kova runs in your home.** Your home's data lives on your own Kova hub, a computer in your home that you
  control. The Kova app talks to **your** hub. It does not send your home's data to ClickBIT.
- **There are no ads, no analytics and no tracking** in the app or the hub. We don't sell or rent your data.
- **Location is optional and off until you turn it on.** When it is on, your phone tells your own hub only
  whether you are **home** or **away**. It never sends your coordinates for this.
- Some things you choose to turn on use other companies' services. These are push notifications, the
  optional cloud AI for Ask Kova, and the accounts you link, such as Google Nest. This policy says what each
  one receives.

## The Kova app

### Connecting to your hub

You connect the app to your hub by scanning a code, finding it on your Wi-Fi, or typing its address. The app
keeps the following in your phone's secure storage (Keychain on iOS, Keystore on Android):

- the hub's addresses
- the hub's ID
- the hub's access token, if your hub has one
- which person in your home the phone belongs to

On iOS, the hub's address and token are also shared with Kova's own widgets and Siri shortcuts on the same
phone, through an App Group. On your home network the app may talk to your hub over plain HTTP. For remote
access, use an HTTPS address for the hub (for example, through a reverse proxy or a private network service).

### Location: arriving and leaving home (optional)

If you turn on **Arrive and leave** (More → This phone), Kova asks your permission to use location,
including **in the background**. This happens even when the app is closed or not in use. Before every
system location prompt, Kova shows its own screen that explains this, and you can say "Not now".

- **What it does:** your phone's operating system watches a circle around your home, about 150 m across by
  default. When you cross the circle, the phone wakes Kova.
- **What is sent:** Kova sends **only "home" or "away"** for you, and the label "Kova app (location)". It
  sends this to **your own hub**, using a key that can only report your own presence. Your coordinates are
  not sent. When you leave, Kova reads your last known position, but only on the phone, to confirm you are
  outside the circle.
- **What is stored on the phone:** your home's coordinates, the circle, your hub's addresses and your
  presence key.
- **What the hub keeps:** a log entry each time you arrive or leave, for example "Sam arrived home". It is
  used for your home's automations and shown in Activity.
- **Who else gets it:** **no one.** Your location is never sent to ClickBIT, advertisers or any other
  company. If you have linked a Warden router to your hub, the hub tells it who is home, on your home
  network.
- **Turning it off:** use More → This phone. You can also take away Kova's location permission in your
  phone's settings.

### Location: setting where your home is (optional, one time)

In Settings → "Where the home is", you can use your phone's current location **once**. Kova shows its own
explanation first. The coordinates go to **your own hub**, rounded to about 1 m, and are saved as your
home's location. Kova does not use background location for this.

Your hub uses the home's location for sunrise, sunset and prayer times, which are worked out on the hub. It
also uses it for the weather and for address search (see "Services your hub uses").

### Push notifications (optional)

If you turn on **Notifications** (More → This phone), the app gets a push token. Your hub then sends you
alerts such as "Someone's at the front door", "Everyone's out and 3 lights are on" or "the internet
dropped".

- **Phone app:** notifications are relayed by **Expo's push service** (Expo, operated by 650 Industries,
  Inc., `exp.host`). Expo passes them to **Apple Push Notification service** or **Google Firebase Cloud
  Messaging**. These services receive the push token and each notification's title and text. No camera
  images are sent in a notification.
- **What is stored:** your hub stores the token, the person it belongs to, your phone's name (for example
  "Sam's Pixel") and its platform.
- **Browsers:** if you get notifications in a web browser, they go through that browser's push service
  (Web Push). If you set up **ntfy** yourself, they go to the ntfy server you chose.
- **Turning it off:** turning notifications off in the app deletes the token from your hub.

### Crash reports

If the app crashes, it sends a crash report **to your own hub only**. A report contains:

- the error message and stack trace
- the screen you were on, and the last few screens before it
- the app version and the platform (iOS or Android)
- the time

It does not include your name, contacts or location. If the hub can't be reached, up to 20 reports wait on
the phone and are sent next time. We use no third-party crash reporting service.

### App updates

The app's over-the-air updates come **from your own hub**, not from ClickBIT's or Expo's servers. Store
versions come from Google Play or the App Store.

### Camera (scanning the code)

The app uses your camera only to scan the code that connects it to your hub. It doesn't take or keep
pictures.

### The demo home

**Try the demo** runs a made-up home inside the app. It has no hub and uses no network. In the demo, Kova
sends nothing anywhere. It also doesn't register for notifications, use your location or check for updates.

## Your Kova hub

The hub runs on hardware in your home. Its data stays in its own data folder on that hardware, mainly a
database file called `kova.db`. This data includes:

- your home's name, rooms, people and devices
- modes and automations
- the Activity log
- the settings and sign-in details for the integrations you link

Whoever runs the hub controls this data. ClickBIT can't see it.

### Ask Kova

Ask Kova answers in one of three ways.

- **Built in (the default).** Kova understands your request on the hub itself. Nothing leaves your home.
- **A local AI model (optional).** This is a model running on your own network, for example Ollama or LM
  Studio. Your requests go to that server.
- **A cloud AI provider (optional).** Kova supports **OpenAI**, **Anthropic**, **MiniMax**, and any
  **OpenAI-compatible** service you enter. Kova only uses one if you turn it on and add your own API key,
  which is stored on your hub.

When an AI model is on, Kova sends it **only requests the built-in assistant couldn't understand**. Each
request is listed in Activity. Every request includes:

- your request, plus the recent conversation (the last 20 turns within 8 hours)
- the current time, mode and overlays, and the names of your modes
- your automations
- the types of your devices and what they can do
- anything you asked Kova to remember, and your standing instructions

Under **What the AI can see**, you choose what else is added:

- **Device and room names** (on by default). When this is off, Kova uses neutral labels instead.
- **Current device states**, such as on or off, brightness, or what's playing (on by default).
- **Activity history:** the last 7 days of changes (off by default).
- **Who's home:** each person's name and whether they're home (off by default).

**Cameras are never shared** with any AI model. Camera devices, their images and their events are left out,
and this can't be turned on. The hub never sends your home's location to an AI model.

When you use a cloud provider, that provider's own privacy policy and terms apply to what it receives. The
hub keeps a log of AI requests: the most recent 200, with the question trimmed to 500 characters and the
reply to 300.

### Cameras and doorbells

Kova shows cameras from **Google Nest**.

- **Detection:** Google detects people and motion, and Kova receives those events from Google's cloud.
- **Live view:** video streams between Google and your phone or browser. The hub does not record it.
- **Event images:** for each camera, the hub keeps **only the latest event picture**. It is stored in the
  hub's data folder, under `nest/`, and replaced by the next one.
- **Recordings:** Kova makes no recordings or clips.

If you have a Helix TV linked, a doorbell picture can be shown on the TV through a one-time link that
expires after two minutes.

### Integrations you link

When you link an account or a device, your hub stores its sign-in details in its data folder. These may be
tokens, keys, or for some services an email address and password. The files can be read only by the hub's
own user, but they are **not encrypted**. The app never shows a stored secret again. Integrations that use
the maker's cloud send commands and read device state through that company's servers:

- **Google Nest:** Google's Smart Device Management API and Cloud Pub/Sub, through your own Google Cloud
  project.
- **Samsung SmartThings:** SmartThings' API. When you link it, the sign-in page sends you to
  `httpbin.org`, where you copy the code back into Kova.
- **Tuya and Smart Life:** your devices are controlled **on your home network**. Tuya's cloud is used to get
  their local keys when you link them, either with a Smart Life QR code or your Tuya IoT Platform keys.
- **VeSync (Levoit):** VeSync's cloud. Your VeSync email and password are stored on the hub.
- **Ecovacs:** Ecovacs' cloud. Your Ecovacs email and password are stored on the hub.
- **Hisense ConnectLife:** ConnectLife's cloud.
- **Warden:** a router on your home network. The hub shares your devices, rooms, who's home and your home's
  mode with it, on your network.
- **Helix:** a media server on your home network.

Local integrations talk only to devices on your network. These include Tapo, Google Cast, Sonos, AirPlay,
GoodWe solar, Matter, Samsung TVs and Apple Home. Each company's own privacy policy applies to what its
service receives.

### Services your hub uses

- **Weather:** the hub asks **MET Norway** (`api.met.no`) for the forecast every 30 minutes. It sends your
  home's location rounded to about 100 m.
- **Address search:** in setup, the hub can look up an address you type. It uses **OpenStreetMap
  Nominatim**, or **Google Maps** if the person running the hub has added a Google Maps key. The service
  receives what you typed and the area around your home.
- **Hub software updates:** with a Kova licence, the hub checks **ClickBIT's update service**
  (`admin.clickbit.com.au`) and downloads updates from it. To do this it sends:
  - your licence key
  - the hub's random ID
  - a random device identifier
  - the version it runs

  It sends **nothing about your home**. Without a licence, a hub installed from source gets updates from
  GitHub. (**TO CONFIRM**: whether ClickBIT logs IP addresses or keeps these activation records, and for how
  long.)
- **Web pages from the hub:** some screens show pages served by your hub, such as live camera view and the
  mode editor. These pages load fonts from **Google Fonts**, so your phone or browser contacts Google when
  they open. (**TO CONFIRM**: whether to bundle these fonts instead.)
- **Remote access:** if you set up remote access (for example a reverse proxy or a private network service
  such as Tailscale), that service carries your app's traffic to the hub.

### Signing in from a browser

To use Kova in a web browser, you approve a short code from a signed-in device. The hub keeps a list of
signed-in browsers, such as "Chrome on Mac", with when each was added and last used. It stores only a
fingerprint (hash) of each browser's key, not the key itself. You can sign a browser out at any time in
More → Sign in a browser.

## Children

Kova is meant to be set up and managed by adults. It is not directed at children, and we don't knowingly
collect children's personal information. (**TO CONFIRM**: the age to state, for example 13, and the store's
target-audience settings.)

A household may add a child to the hub, for example by name, or a room called "Kids' room". That
information stays on the household's own hub.

## How long data is kept

- **On the phone:** Kova's settings stay until you disconnect the phone from the hub (More → This phone →
  Disconnect) or uninstall the app.
- **On the hub:** data stays until you delete it or remove the hub's data folder. The limits are:
  - **Activity log:** device changes, presence, notifications, crash reports and AI requests are currently
    **kept with no time limit**. (**TO CONFIRM**: a retention period, and an option to clear Activity.)
  - **Automation runs:** the last 30 runs of each automation.
  - **AI request log:** the last 200 requests.
  - **Backups:** the hub makes a backup each night in its own data folder and keeps the newest 14. Backups
    stay on the hub, unless the person running it chooses another folder. Kova does not upload them
    anywhere.
- **Linked services** keep data under their own policies.
- **ClickBIT:** licence and update records are kept as described above (**TO CONFIRM**).

## Your choices and deleting your data

- **Location, notifications and the AI:** turn location or notifications off in More → This phone. Change
  or turn off the AI and what it can see in Ask Kova's settings on the hub.
- **This phone:** disconnecting the phone deletes the hub's details from the phone, stops location and
  removes its push token from the hub.
- **People:** you can remove a person in Customise home. Their past entries stay in the Activity log
  (**TO CONFIRM**, see above).
- **Linked services:** unlinking a service deletes its stored sign-in details from the hub. You can also
  revoke Kova's access in that company's account settings.
- **Everything:** deleting the hub's data folder, and its backups, deletes everything the hub holds.

Because your home's data is on your own hub, not with us, **you** or whoever runs your hub can see, export
and delete it. For data ClickBIT holds, which is licence and update records, contact us (below).

## Security

- Your hub's token, and each person's presence key, limit who can control your home.
- The app stores its details in the phone's secure storage.
- Sign-in files on the hub can be read only by the hub's own user.
- Keep your hub up to date, and use HTTPS for any address the hub can be reached at from outside your home.

## Changes to this policy

If we change this policy, we will update the date at the top. If a change affects what Kova collects or
where it goes, we will say so in the app's "What's new".

## Contact

Questions or requests about privacy: **privacy@clickbit.com.au** (**TO CONFIRM**). Postal address: **TO
CONFIRM**.

If you're in Australia and not satisfied with our answer, you can contact the Office of the Australian
Information Commissioner (<https://www.oaic.gov.au>). (**TO CONFIRM**: which privacy laws ClickBIT treats as
applying, for example the Australian Privacy Act, or the GDPR for users in Europe.)
