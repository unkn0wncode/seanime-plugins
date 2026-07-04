# Rain's Seanime Plugins

Plugins for Seanime.

## Rain's Utils

Remembers your player choices across episodes and sessions:

- **Subtitles & captions** — re-applies your last picked track (or "Off") on every load, matched by language/label.
- **Video quality** — re-applies your last picked quality. Seanime has no plugin API for quality, so the plugin invisibly drives the player's own Quality menu to apply it (HLS levels included).

Both features can be toggled independently from the tray icon, which also has a debug log (Show / Copy / Clear).

### Install

1. In Seanime, go to **Settings → Extensions**.
2. Add an extension using this manifest URL:

   ```
   https://raw.githubusercontent.com/unkn0wncode/seanime-plugins/main/plugins/rains-utils/manifest.json
   ```

3. Grant the requested permissions (**playback**, **storage**) when prompted.
4. Play something, pick a subtitle track / quality in the player menu — the choice is saved and re-applied on the next episode.

### Notes

- For online streaming with direct (non-HLS) sources, Seanime already remembers quality natively; the plugin's quality restore mainly matters for HLS streams (levels like Auto/720p/1080p).
- Restoring a specific HLS level disables adaptive bitrate for that stream — pick "Auto" if your connection fluctuates.
- Quality restore is best-effort: it identifies the player's Video menu by its icon, so a future Seanime UI overhaul may require a plugin update. Saving is unaffected.
