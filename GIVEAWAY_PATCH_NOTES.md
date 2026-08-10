# Free Giveaway patch

Implemented:
- Multi-channel required joins (all selected channels must be joined).
- Admin multi-select channel picker with selected state.
- User channel status buttons: green/success for joined, red/danger for missing, blue/primary recheck.
- Backward compatibility for legacy requireChannelId/requireChannelTitle giveaways.
- Shop giveaway stock is reserved atomically when coupon is claimed.
- OrderService consumes giveaway stock reservation instead of decrementing stock twice.
- Unused shop reservations are returned when a giveaway is repicked/deleted.
- Product repick resets campaign claim count/history, stops giveaway, clears announcement linkage.
- Giveaway cannot restart when max-claim quota is already full.
- Max Claims cannot be set to a non-zero value less than or equal to already claimed count.
