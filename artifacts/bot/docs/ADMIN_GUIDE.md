# Mental Gaming Store — Admin Guide

## 1. ကြော်ငြာ channel တည်ဆောက်ခြင်း

ကြော်ငြာ channel ထဲမှာ bot ကို **Administrator** အဖြစ်ထည့်ပြီး **Post Messages** permission ကို ဖွင့်ထားပါ။

Bot ထဲမှာ —

1. `/channels` ရိုက်ပါ။
2. `➕ Channel ထည့်မယ်` ကိုနှိပ်ပါ။
3. Channel ရဲ့ `@username` (သို့) `-100...` ID ကို ရိုက်ပါ။
4. `📢 ကြေညာချက် channel အဖြစ်သတ်မှတ်` ကို ရွေးပါ။
5. Bot က channel နဲ့ posting permission ကို စစ်ပြီးမှ save လုပ်ပါမယ်။

အခြားနည်းလမ်းအဖြစ် Owner က —

```text
/setannouncechannel @your_channel
/checkannounce
```

ကို သုံးနိုင်ပါတယ်။ `/checkannounce` က channel ID, bot admin status နဲ့ Post Messages ခွင့်ကို စစ်ပေးပါတယ်။

## 2. Product ကြော်ငြာတင်ခြင်း

1. Admin menu မှ `📣 Announce` ကိုနှိပ်ပါ (သို့) `/announce` ရိုက်ပါ။
2. Active product သို့ Premium Account product တစ်ခုရွေးပါ။
3. Shop product ဖြစ်ရင် `🆕 New Product` သို့ `⚡ Flash Sale` ကိုရွေးပါ။
4. Bot က announcement channel နဲ့ bot user တွေဆီ ပို့ပါမယ်။
5. အောင်မြင်မှုစာထဲမှာ channel result, sent users, blocked users, failed users ကို ကြည့်နိုင်ပါတယ်။

Direct product ID သုံးလိုပါက —

```text
/announce <productId>
```

## 3. ကြော်ငြာမတက်ရင် စစ်ရန်

`/checkannounce` ကို အရင်ရိုက်ပါ။

| Bot ပြတဲ့အကြောင်းရင်း | ဖြေရှင်းနည်း |
|---|---|
| Announcement channel မသတ်မှတ်ရသေး | `/channels` မှာ 📢 ကြော်ငြာချက် channel အဖြစ် သတ်မှတ်ပါ |
| Bot ကို admin မထည့်ထား | Channel settings → Administrators → Bot ထည့်ပါ |
| Post Messages ခွင့်မရှိ | Bot admin permissions မှာ Post Messages ဖွင့်ပါ |
| Channel စစ်မရ / chat not found | `@username` မှန်မမှန် စစ်ပါ၊ private channel ဖြစ်ရင် numeric `-100...` ID သုံးပါ |
| Product မတွေ့ | Product ကို active ဖြစ်အောင်ထားပြီး `/announce` ကို ပြန်ဖွင့်ပါ |
| Flash sale မရ | Product မှာ flash sale price အရင်သတ်မှတ်ပါ |
| User count မတက် | User က bot ကို block လုပ်ထားနိုင်ပါတယ်; channel post ကတော့ သီးခြားအောင်မြင်နိုင်ပါတယ် |

Product စာသားထဲမှာ Telegram Markdown မသင့်တဲ့ character ပါရင် bot က plain-text retry လုပ်ပေးထားပါတယ်။ ထပ်မတက်ပါက result message ထဲက `Channel` error အကြောင်းရင်းကို လိုက်ဖြေရှင်းပါ။

## 4. Permission အကျဉ်းချုပ်

- **Owner** — channel setup, `/checkannounce`, system settings
- **Manager+** — `/announce`, product announcement
- Bot — announcement channel တွင် Administrator + Post Messages

## 5. သက်ဆိုင်ရာ code နေရာများ

- `src/commands/apiManagement.js` — `/announce`, `/setannouncechannel`, `/checkannounce`
- `src/commands/channelManager.js` — `/channels` purpose picker
- `src/services/BroadcastService.js` — channel validation, formatting, delivery result
- `src/models/SystemStatus.js` — `announcementChannelId`
- `src/commands/admin.js` — in-bot interactive Admin Guide