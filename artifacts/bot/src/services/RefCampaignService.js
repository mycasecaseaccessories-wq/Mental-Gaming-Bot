/**
 * RefCampaignService — counts completed referrals toward the active campaign
 * and auto-grants rewards, respecting per-user and campaign-wide limits.
 *
 * Concurrency-safe: all counter updates use conditional findOneAndUpdate + $inc
 * so parallel top-up approvals can never double-pay or overshoot quotas.
 */
const RefCampaign = require('../models/RefCampaign');
const RefCampaignEntry = require('../models/RefCampaignEntry');
const { creditCoin, creditKS } = require('./WalletService');
const { generateCoupon } = require('./PromoService');
const { auditLog } = require('./logger');
const { estimateAccountAgeDays } = require('../utils/accountAge');
const { config } = require('../../config/settings');

function rewardText(c) {
  if (c.rewardType === 'mc') return `${c.rewardAmount} MC`;
  if (c.rewardType === 'ks') return `${c.rewardAmount.toLocaleString()} KS`;
  if (c.rewardType === 'product_free') return `🎁 ${c.rewardLabel || 'Product'} (အခမဲ့)`;
  return c.rewardLabel || 'Product';
}

/**
 * Called when a referral is completed for the first time (referee's first
 * qualifying top-up). Increments progress and grants rewards when due.
 */
async function onReferralCompleted(referrer, telegram, referee = null, topupAmount = 0) {
  try {
    const camp = await RefCampaign.getActive();
    if (!camp) return null;

    // Anti-gaming: invited user's first top-up must meet the campaign minimum
    if (camp.minRefereeTopup > 0 && topupAmount < camp.minRefereeTopup) {
      try {
        if (telegram) {
          await telegram.sendMessage(
            referrer.telegramId,
            `🎯 Campaign "${camp.title}"\n\n⚠️ ဒီ ref ကို campaign မှာ မတွက်ပေးနိုင်ပါ — ဖိတ်ခံရသူက အနည်းဆုံး ${camp.minRefereeTopup.toLocaleString()} KS ငွေဖြည့်ရပါမယ် (ဒီတစ်ကြိမ် ${topupAmount.toLocaleString()} KS ပဲ ဖြည့်ထားလို့ပါ)။\n\n_ပုံမှန် referral commission ကတော့ ရရှိပြီးသားပါ။_`
          );
        }
      } catch {}
      await auditLog(referrer.telegramId, 'REF_CAMPAIGN_TOPUP_REJECT', camp._id.toString(), 'System', {
        refereeId: referee ? referee.telegramId : null, topupAmount, minRequired: camp.minRefereeTopup,
      });
      return null;
    }

    // Anti-fraud: invited user's estimated Telegram account age must meet minimum
    if (camp.minRefereeAgeDays > 0 && referee) {
      const ageDays = estimateAccountAgeDays(referee.telegramId);
      if (ageDays < camp.minRefereeAgeDays) {
        try {
          if (telegram) {
            await telegram.sendMessage(
              referrer.telegramId,
              `🎯 Campaign "${camp.title}"\n\n⚠️ ဒီ ref ကို campaign မှာ မတွက်ပေးနိုင်ပါ — ဖိတ်ခံရသူရဲ့ Telegram account သက်တမ်းက အနည်းဆုံး ${camp.minRefereeAgeDays} ရက် ရှိရပါမယ် (ခန့်မှန်း ${ageDays} ရက်ပဲ ရှိသေးလို့ပါ)။\n\n_ပုံမှန် referral commission ကတော့ ရရှိပြီးသားပါ။_`
            );
          }
        } catch {}
        await auditLog(referrer.telegramId, 'REF_CAMPAIGN_AGE_REJECT', camp._id.toString(), 'System', {
          refereeId: referee.telegramId, estAgeDays: ageDays, minRequired: camp.minRefereeAgeDays,
        });
        return null;
      }
    }

    // Ensure entry exists (idempotent upsert)
    await RefCampaignEntry.updateOne(
      { campaignId: camp._id, telegramId: referrer.telegramId },
      { $setOnInsert: { userId: referrer._id, countedRefs: 0, totalRefs: 0, rewardsClaimed: 0 } },
      { upsert: true }
    );

    // Atomically count this referral, respecting the per-user invite cap
    const countFilter = { campaignId: camp._id, telegramId: referrer.telegramId };
    if (camp.maxInvitesPerUser > 0) countFilter.totalRefs = { $lt: camp.maxInvitesPerUser };
    let entry = await RefCampaignEntry.findOneAndUpdate(
      countFilter,
      { $inc: { totalRefs: 1, countedRefs: 1 } },
      { new: true }
    );
    if (!entry) return null; // invite cap reached — not counted

    const granted = [];
    const coupons = []; // product_free reward coupon codes issued this round

    // Grant as many rewards as earned (usually 0 or 1)
    // Each iteration: (1) atomically reserve from user's counters,
    // (2) atomically reserve a campaign-wide quota slot, (3) deliver.
    for (;;) {
      // (1) Reserve from user's progress
      const entryFilter = { _id: entry._id, countedRefs: { $gte: camp.requiredRefs } };
      if (camp.maxRewardsPerUser > 0) entryFilter.rewardsClaimed = { $lt: camp.maxRewardsPerUser };
      const updatedEntry = await RefCampaignEntry.findOneAndUpdate(
        entryFilter,
        { $inc: { countedRefs: -camp.requiredRefs, rewardsClaimed: 1 } },
        { new: true }
      );
      if (!updatedEntry) break;
      entry = updatedEntry;

      // (2) Reserve a campaign-wide quota slot (and require still active)
      const campFilter = { _id: camp._id, isActive: true };
      if (camp.totalRewardLimit > 0) {
        campFilter.totalRewardsClaimed = { $lt: camp.totalRewardLimit };
      }
      const updatedCamp = await RefCampaign.findOneAndUpdate(
        campFilter,
        { $inc: { totalRewardsClaimed: 1 } },
        { new: true }
      );
      if (!updatedCamp) {
        // Quota full or campaign ended meanwhile — roll back user reservation
        await RefCampaignEntry.updateOne(
          { _id: entry._id },
          { $inc: { countedRefs: camp.requiredRefs, rewardsClaimed: -1 } }
        );
        entry = await RefCampaignEntry.findById(entry._id);
        break;
      }

      // (3) Deliver reward
      try {
        if (camp.rewardType === 'mc') {
          await creditCoin(referrer._id, camp.rewardAmount, {
            type: 'Bonus', note: `Ref campaign reward: ${camp.title}`,
          });
        } else if (camp.rewardType === 'ks') {
          await creditKS(referrer._id, camp.rewardAmount, {
            type: 'Bonus', note: `Ref campaign reward: ${camp.title}`,
          });
        } else if (camp.rewardType === 'product_free') {
          // product_free — auto-issue a personal 100%-off coupon for the bot
          // product so the winner can buy it once for free in the shop.
          // Only mint if the product still exists AND is active, otherwise the
          // coupon would be un-redeemable (orderScene/OrderService reject
          // missing/inactive products) — fall back to manual admin delivery.
          const Product = require('../models/Product');
          const prod = camp.rewardProductId ? await Product.findById(camp.rewardProductId) : null;
          if (prod && prod.isActive) {
            const promo = await generateCoupon(config.bot.adminId, {
              discountType: 'Percentage',
              value: 100,
              maxUses: null,
              perUserLimit: 1,
              scopeType: 'product',
              scopeProducts: [prod._id],
              restrictedToUserId: referrer._id,
              source: 'reward',
              description: `Ref campaign free product: ${camp.title}`,
              prefix: 'REF',
            });
            coupons.push(promo.code);
          } else {
            // linked product deleted/inactive — alert admin for manual remedy
            try {
              await telegram.sendMessage(
                config.bot.adminId,
                `🎯 Campaign ဆု ပေးရန်! (⚠️ ဆု product မရှိတော့/ပိတ်ထား — coupon မထုတ်နိုင်)\n\nCampaign: ${camp.title}\nUser: ${referrer.username ? '@' + referrer.username : referrer.telegramId} (ID: ${referrer.telegramId})\nဆု: ${camp.rewardLabel}\n\n→ လက်ဖြင့် ပို့ပေးပါ။`
              );
            } catch {}
          }
        } else {
          // product — manual delivery: alert admin
          try {
            await telegram.sendMessage(
              config.bot.adminId,
              `🎯 Campaign ဆု ပေးရန်!\n\nCampaign: ${camp.title}\nUser: ${referrer.username ? '@' + referrer.username : referrer.telegramId} (ID: ${referrer.telegramId})\nဆု: ${camp.rewardLabel}\n\n→ လက်ဖြင့် ပို့ပေးပါ။`
            );
          } catch {}
        }
      } catch (deliverErr) {
        // Wallet credit failed — roll back both reservations, alert admin
        console.error('[RefCampaign] ❌ Reward delivery failed:', deliverErr.message);
        await RefCampaignEntry.updateOne(
          { _id: entry._id },
          { $inc: { countedRefs: camp.requiredRefs, rewardsClaimed: -1 } }
        );
        await RefCampaign.updateOne({ _id: camp._id }, { $inc: { totalRewardsClaimed: -1 } });
        try {
          await telegram.sendMessage(
            config.bot.adminId,
            `⚠️ Campaign ဆုပေးရာမှာ error တက်လို့ ပြန်ရုပ်သိမ်းလိုက်ပါတယ်။\nUser: ${referrer.telegramId}\nError: ${deliverErr.message}`
          );
        } catch {}
        break;
      }

      granted.push(rewardText(camp));
      await auditLog(referrer.telegramId, 'REF_CAMPAIGN_REWARD', camp._id.toString(), 'System', { reward: rewardText(camp) });

      // Quota full → atomically end campaign (only one caller wins)
      if (updatedCamp.totalRewardLimit > 0 && updatedCamp.totalRewardsClaimed >= updatedCamp.totalRewardLimit) {
        const ended = await RefCampaign.findOneAndUpdate(
          { _id: camp._id, isActive: true },
          { $set: { isActive: false, endedAt: new Date(), endReason: 'quota_full' } },
          { new: true }
        );
        if (ended) {
          try {
            await telegram.sendMessage(
              config.bot.adminId,
              `🏁 Campaign "${camp.title}" — ဆု ${updatedCamp.totalRewardLimit} ခု ပြည့်သွားလို့ အလိုအလျောက် ပိတ်လိုက်ပါပြီ။`
            );
          } catch {}
        }
        break;
      }
    }

    await notifyUser(telegram, referrer, camp, entry, granted, coupons);
    return { granted };
  } catch (err) {
    console.error('[RefCampaign] ❌ onReferralCompleted:', err.message);
    return null;
  }
}

async function notifyUser(telegram, referrer, camp, entry, granted, coupons = []) {
  if (!telegram) return;
  try {
    if (granted.length) {
      let tail;
      if (camp.rewardType === 'product_free') {
        tail = coupons.length
          ? `\n\n🎟 သင့် coupon code: ${coupons.join(', ')}\n\n` +
            `👉 Shop ထဲဝင် → "${camp.rewardLabel}" ကို ရွေး → coupon သုံးပြီး အခမဲ့ ဝယ်လိုက်ပါ!\n` +
            `(order လုပ်တဲ့အခါ ဒီ coupon က button အဖြစ် အလိုအလျောက် ပေါ်ပါလိမ့်မယ်။)`
          : `\n\nAdmin က မကြာခင် ဆက်သွယ်ပြီး ပို့ပေးပါမယ်။`;
      } else if (camp.rewardType === 'product') {
        tail = `\n\nAdmin က မကြာခင် ဆက်သွယ်ပြီး ပို့ပေးပါမယ်။`;
      } else {
        tail = `\n\nWallet ထဲ ထည့်ပြီးပါပြီ။`;
      }
      await telegram.sendMessage(
        referrer.telegramId,
        `🎁 Campaign ဆု ရပါပြီ!\n\n🎯 ${camp.title}\n🏆 ဆု: ${granted.join(', ')}${tail}`
      );
    } else {
      const remain = Math.max(0, camp.requiredRefs - (entry?.countedRefs || 0));
      await telegram.sendMessage(
        referrer.telegramId,
        `🎯 Campaign တိုးတက်မှု!\n\n"${camp.title}"\n📊 ${entry?.countedRefs || 0}/${camp.requiredRefs} — နောက် ${remain} ယောက်ပဲ လိုပါတော့တယ်!\n🏆 ဆု: ${rewardText(camp)}`
      );
    }
  } catch {}
}

module.exports = { onReferralCompleted, rewardText };
