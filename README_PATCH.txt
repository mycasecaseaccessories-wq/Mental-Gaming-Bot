Mental Gaming - Store + Admin Emoji Patch

Changes:
- Store hub: Shop -> Products (EN/MM), while preserving previous i18n/VPN availability fixes.
- Product list: 2-column inline buttons.
- Product list: green/red stock status marker.
- Product list: custom DB emoji first, automatic name-based emoji as fallback.
- Product model: optional emoji field added (no manual DB migration required).
- Admin Product Detail: shows current emoji / Auto.
- Admin Edit Fields: adds Emoji editor; send '-' to clear and return to Auto.
- Product cache invalidated after admin field edit so Store updates immediately.

Replit install from project root:
  unzip -o Mental.zip

Then restart the bot and test Store -> Products and Admin -> Manage Products -> product -> Edit Fields -> Emoji.
