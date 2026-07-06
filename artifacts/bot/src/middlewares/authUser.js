const User = require('../models/User');

function attachUser() {
  return async (ctx, next) => {
    if (!ctx.from) return next();

    try {
      let user = await User.findOrCreate(ctx.from.id, ctx.from.username, ctx.from.first_name);

      if (!user) {
        // Retry once after a short delay — can happen during race conditions or brief DB hiccups
        await new Promise((r) => setTimeout(r, 250));
        user = await User.findOrCreate(ctx.from.id, ctx.from.username, ctx.from.first_name);
      }

      if (!user) {
        console.error('[AuthUser] findOrCreate returned null for:', ctx.from.id);
        return next();
      }

      if (user.isBlocked) {
        return ctx.reply('🚫 Your account has been suspended. Contact support.');
      }

      ctx.user = user;
    } catch (err) {
      console.error('[AuthUser] Error fetching user:', err.message);
    }

    return next();
  };
}

function requireRight(right) {
  return async (ctx, next) => {
    if (!ctx.user) return ctx.reply('❌ Could not verify your account. Try again.');

    if (!ctx.user.hasRight(right)) {
      return ctx.reply(`⛔ You do not have permission to perform this action.`);
    }

    return next();
  };
}

module.exports = { attachUser, requireRight };
