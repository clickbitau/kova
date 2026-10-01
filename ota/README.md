# Over-the-air bundles for the Kova phone app

The hub serves these to the app (`GET /api/app/manifest`, `hub/src/api/app-updates.ts`), so an
update comes from the hub on your network, not a cloud service.

    ota/<train>/<update>/      one `expo export` per over-the-air release, for both platforms
        metadata.json
        expoConfig.json        the app config, with this bundle's version (0.1.3)
        _expo/static/js/…
        assets/…

`<train>` is the native runtime (`kova-mobile-0.1`): a bundle only reaches binaries built from the
same native code. The newest `<update>` wins; deleting it rolls phones back to the one before.

Made by `node scripts/export-ota.mjs "What changed"` (docs/VERSIONING.md), committed with the
version bump. Set `KOVA_OTA_DIR` to serve them from somewhere else.
