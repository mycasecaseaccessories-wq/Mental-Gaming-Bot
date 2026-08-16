# Mental Gaming Bot — Code Quality & Best-Practices Roadmap

## အကျဉ်းချုပ်

Repository သည် Telegram bot၊ API server၊ React storefront၊ Outline bot နှင့် mockup preview ကို monorepo တစ်ခုအတွင်း ထည့်သွင်းထားသည်။ လက်ရှိ structure သည် feature များစွာပါဝင်ပြီး functional test အချို့ကောင်းမွန်သော်လည်း long-term maintainability အတွက် **language standardization၊ package boundary၊ automated quality gates၊ security hardening နှင့် operational discipline** ကို ပိုမိုတင်းကျပ်ရန်လိုသည်။

အရေးကြီးဆုံး အကြံပြုချက်မှာ production dependency vulnerabilities များကို အရင် patch လုပ်ခြင်း၊ clean checkout မှ root build အောင်မြင်အောင် ပြင်ခြင်း၊ JavaScript bot code ကို incremental TypeScript သို့ ရွှေ့ခြင်း၊ ကြီးမားသော command/route files များကို use-case modules ခွဲခြင်းနှင့် GitHub CI quality gate တည်ဆောက်ခြင်းတို့ဖြစ်သည်။

## လက်ရှိအခြေအနေမှ တွေ့ရှိချက်

| ဧရိယာ           | လက်ရှိအခြေအနေ                                                                                               | သက်ရောက်မှု                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Monorepo        | Bot, API, landing, outline-bot, mockup နှင့် shared libs တစ်နေရာတည်းတွင် ရှိသည်                             | Boundary မရှင်းလျှင် dependency နှင့် deployment complexity တိုးနိုင်သည် |
| Bot code        | JavaScript source ၁၆၉ ဖိုင်ခန့်ရှိပြီး command/route files အချို့ ၁,၀၀၀–၁,၈၀၀ lines ကျော်သည်                | Review, testing နှင့် change isolation ခက်ခဲသည်                          |
| Type safety     | API/shared libraries နှင့် frontend က TypeScript သုံးသော်လည်း bot နှင့် outline-bot က JavaScript ဖြစ်သည်    | Runtime bug နှင့် contract mismatch ဖြစ်နိုင်ခြေ မြင့်သည်                |
| Testing         | Bot tests ၁၇ ခု pass ဖြစ်သော်လည်း API, frontend, webhook, database integration နှင့် E2E coverage မပြည့်စုံ | Regression များကို CI တွင် အပြည့်အဝ မဖမ်းနိုင်ပါ                         |
| Quality tooling | ESLint, Prettier, coverage gate နှင့် GitHub Actions workflow မတွေ့ရ                                        | Style drift နှင့် quality regression များကို အလိုအလျောက်မတားနိုင်ပါ      |
| Security        | Production dependency audit တွင် vulnerability ၃၀ ခု၊ high ၁၁ ခုတွေ့ရသည်                                    | Production exposure risk ရှိသည်                                          |
| Build workflow  | `pnpm` install/build သည် `esbuild` build-script policy ကြောင့် clean environment တွင် fail ဖြစ်နိုင်သည်     | Deployment reproducibility ထိခိုက်သည်                                    |

## Priority 0 — မဖြစ်မနေ အရင်ပြင်ရန်

### ၁။ Dependency security ကို ရှင်းလင်းပါ

`pnpm audit --prod` တွင် တွေ့ရသော `axios`, `path-to-regexp`, `multer`, `form-data` နှင့် `ip-address` chain များကို patched versions သို့ update လုပ်ပါ။ Direct dependency မဟုတ်သည့် package များအတွက် transitive upgrade ဖြစ်မဖြစ် lockfile ကို စစ်ပါ။ Upgrade တစ်ခုချင်းစီပြီးနောက် bot tests၊ API build နှင့် smoke tests ပြန် run လုပ်ပါ။

Production အတွက် dependency update policy တစ်ခုထားပြီး monthly update window နှင့် emergency security update process ခွဲထားသင့်သည်။ `pnpm audit --prod --audit-level high` ကို CI required check အဖြစ် သတ်မှတ်ပြီး high/critical များကျန်လျှင် merge မဖြစ်စေရန်လုပ်ပါ။

### ၂။ Secrets နှင့် environment configuration ကို တစ်နေရာတည်း စီမံပါ

`process.env` ကို service files အများအပြားမှ တိုက်ရိုက်ဖတ်မည့်အစား package တစ်ခုချင်းစီအတွက် typed `config` module တစ်ခုထားပါ။ Startup အချိန်တွင် required variables မရှိလျှင် အဓိပ္ပာယ်ရှိသော error ဖြင့် ချက်ချင်းရပ်ပါ။ Token၊ database URI နှင့် encryption secret များကို log မထုတ်ပါနှင့်။ `.env.example` ကို variables အားလုံး၊ default behavior နှင့် production requirement များပါဝင်အောင် update လုပ်ပါ။

ဥပမာအားဖြင့် `BOT_TOKEN`, `MONGODB_URI`, `SESSION_SECRET`, `WEBHOOK_SECRET`, `CORS_ALLOWED_ORIGINS` တို့ကို development/production အလိုက် ခွဲပြီး validate လုပ်သင့်သည်။ Secret rotation နှင့် revoked token procedure ကို `ADMIN_GUIDE.md` တွင် ရေးထားသင့်သည်။

### ၃။ Clean install/build ကို deterministic ဖြစ်အောင် ပြင်ပါ

`pnpm install --frozen-lockfile` သည် CI နှင့် developer machine နှစ်ခုလုံးတွင် တူညီစွာ အောင်မြင်ရမည်။ `esbuild` ကဲ့သို့ native/build-script dependency များအတွက် project-level pnpm configuration နှင့် CI setup ကို တစ်မျိုးတည်းထားပါ။ Package manager version ကို `packageManager` field နှင့် CI toolchain ဖြင့် pin လုပ်ပါ။

Root build script သည် hidden environment variable များ မလိုဘဲ clean checkout မှ run နိုင်ရမည်။ mockup အတွက် `PORT` နှင့် `BASE_PATH` ကဲ့သို့ လိုအပ်သော variable များကို `.env.example` သို့မဟုတ် documented command ဖြင့် ပေးထားသင့်သည်။

## Priority 1 — Architecture နှင့် maintainability

### ၄။ Bot JavaScript ကို incremental TypeScript သို့ ပြောင်းပါ

တစ်ကြိမ်တည်း rewrite မလုပ်ဘဲ `src/config`, `src/services`, `src/utils` ထဲမှ boundary ကောင်းသော modules များကို အရင် `.ts` သို့ပြောင်းပါ။ `allowJs` ဖြင့် transitional mode ထားပြီး strictness ကို package အလိုက် တဖြည်းဖြည်း တိုးပါ။ Shared types များကို `@workspace/api-zod` သို့မဟုတ် `@workspace/contracts` ထဲတွင်ထားကာ Telegram update, order, wallet, referral, webhook payload များအတွက် schema တစ်မျိုးတည်း အသုံးပြုပါ။

TypeScript ပြောင်းခြင်း၏ ရည်ရွယ်ချက်မှာ syntax ပြောင်းရုံမဟုတ်ဘဲ input validation၊ service return types၊ error types နှင့် database document shape များကို explicit ဖြစ်စေရန်ဖြစ်သည်။

### ၅။ ကြီးမားသော command/route files များကို use-case အလိုက် ခွဲပါ

`admin.js`, `accounts.js`, `accountGiveaway.js`, `catalogAdmin.js`, `admin.ts` နှင့် `store.ts` ကဲ့သို့ file ကြီးများတွင် transport layer၊ authorization၊ validation၊ business logic နှင့် persistence logic ရောထွေးနေသော risk ရှိသည်။ အောက်ပါ layer များဖြင့် ခွဲပါ။

| Layer                | တာဝန်                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| Handler/controller   | Telegram event သို့ HTTP request ကိုဖတ်ပြီး response ပြန်ခြင်း           |
| Policy/authorization | user role၊ ownership နှင့် permission စစ်ခြင်း                           |
| Validator            | Zod schema ဖြင့် input စစ်ခြင်း                                          |
| Use case/service     | order, referral, wallet, campaign စသည့် business rule ကို ကိုင်တွယ်ခြင်း |
| Repository           | MongoDB/Drizzle query များကို encapsulate လုပ်ခြင်း                      |
| Presenter/mapper     | Telegram keyboard၊ API response သို့ output ပြောင်းခြင်း                 |

Command တစ်ခုသည် database model ကို တိုက်ရိုက်ခေါ်သုံးခြင်းမပြုဘဲ use case တစ်ခုမှတစ်ဆင့်သာ သုံးသင့်သည်။ ဤပုံစံက transaction၊ retry၊ audit log နှင့် test isolation ကို လွယ်ကူစေသည်။

### ၆။ Bot နှင့် Outline bot အကြား duplication လျှော့ပါ

Bot နှစ်ခုတွင် dotenv၊ mongoose၊ axios၊ telegraf နှင့် nodemon တူညီသော dependency ပုံစံများရှိသည်။ တူညီသော config validation၊ logger၊ retry/backoff၊ database connection lifecycle နှင့် error formatting ကို shared internal package သို့မဟုတ် shared utility အဖြစ် ခွဲနိုင်သည်။ သို့သော် bot-specific business logic ကို အတင်းအကျပ် shared မလုပ်ဘဲ dependency direction ကို တစ်ဖက်တည်းထားပါ။

### ၇။ Database access နှင့် side effect များကို transaction boundary ဖြင့် စီမံပါ

Wallet credit၊ referral reward၊ order status၊ giveaway claim နှင့် webhook processing ကဲ့သို့ money-like state များတွင် idempotency key၊ unique index၊ transaction/atomic update နှင့် audit event တို့ကို အမြဲထည့်ပါ။ External provider call ကို database transaction အတွင်း တိုက်ရိုက်ကြာရှည်စွာ မထားဘဲ pending state → provider call → verified result → final state ပုံစံသုံးပါ။ Retry လုပ်သောအခါ duplicate credit မဖြစ်စေရန် operation ID ကို unique လုပ်ပါ။

## Priority 1 — Testing strategy

### ၈။ Test pyramid ကို ပြည့်စုံအောင် တည်ဆောက်ပါ

လက်ရှိ bot unit/integration tests များသည် ကောင်းမွန်သော အခြေခံဖြစ်သော်လည်း API နှင့် frontend တို့တွင် test layer မလုံလောက်ပါ။ အောက်ပါအတိုင်း တိုးချဲ့ပါ။

| Test အမျိုးအစား     | အဓိက coverage                                                                 |
| ------------------- | ----------------------------------------------------------------------------- |
| Unit                | price calculation၊ tier၊ validation၊ masking၊ permission policy၊ retry policy |
| Service integration | MongoDB repository၊ webhook idempotency၊ wallet/referral transaction          |
| API contract        | OpenAPI/Zod request/response compatibility၊ auth၊ rate limit၊ error format    |
| Bot interaction     | command → middleware → handler → response flow                                |
| Frontend component  | form validation၊ loading/error/empty state၊ navigation                        |
| E2E smoke           | login/mini-app၊ catalog → order → payment status၊ admin permission            |

Coverage percentage တစ်ခုတည်းကို မလိုက်ဘဲ critical business paths အတွက် minimum threshold ထားပါ။ Money, admin permission, webhook, backup/restore နှင့် account credential flows တွင် regression test မပါဘဲ feature merge မလုပ်သင့်ပါ။

### ၉။ Test isolation နှင့် fake external services ထားပါ

Real Telegram, real MongoDB နှင့် real payment provider ကို unit tests မှာ မခေါ်ပါနှင့်။ Test factory၊ in-memory database သို့မဟုတ် isolated test database၊ fake clock နှင့် provider adapters အသုံးပြုပါ။ Cron jobs များကို injectable scheduler ဖြင့် ရေးထားပါက time-based test များ deterministic ဖြစ်လာမည်။

## Priority 1 — Quality tooling နှင့် CI/CD

### ၁၀။ Formatting နှင့် linting ကို automated လုပ်ပါ

Root မှ Prettier config တစ်ခုနှင့် ESLint config များကို package အားလုံး share လုပ်ပါ။ CI တွင် အနည်းဆုံး အောက်ပါ checks များ ပါဝင်သင့်သည်။

```text
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod --audit-level high
```

JavaScript package များအတွက် `no-floating-promises` equivalent rule၊ unused variables၊ unsafe `any`၊ console logging policy၊ import ordering နှင့် no-secret-in-source rules ထားပါ။ Auto-format PR နှင့် lint fix ကို developer machine တွင် pre-commit hook ဖြင့်လုပ်နိုင်သော်လည်း CI ကို source of truth အဖြစ်ထားပါ။

### ၁၁။ GitHub Actions workflow ထည့်ပါ

`.github/workflows/ci.yml` တွင် pull request နှင့် main push နှစ်ခုလုံးအတွက် Node/pnpm version pin၊ dependency cache၊ quality checks၊ test artifact နှင့် build artifact တို့ထည့်ပါ။ Branch protection ဖြင့် CI မအောင်မြင်လျှင် merge မဖြစ်စေရန် သတ်မှတ်ပါ။ Deployment ကို build/test အောင်မြင်ပြီးမှသာ manual approval သို့မဟုတ် protected environment ဖြင့် ခွင့်ပြုပါ။

### ၁၂။ Release နှင့် migration process သတ်မှတ်ပါ

Semantic versioning မသုံးလျှင်ပင် conventional commit ပုံစံ၊ changelog၊ release tag နှင့် rollback procedure တစ်ခုထားပါ။ Database schema/migration ပြောင်းလဲမှုများကို application deploy နှင့် ခွဲပြီး backward-compatible migration အရင် run လုပ်ပါ။ PM2 process နှစ်ခု၏ version၊ environment၊ log location နှင့် health check ကို release checklist ထဲတွင် ထည့်ပါ။

## Priority 2 — Security နှင့် operations

### ၁၃။ API security baseline ကို တင်းကျပ်ပါ

Helmet၊ CORS နှင့် rate limit ရှိပြီးသားဖြစ်သော်လည်း route အလိုက် authentication/authorization matrix ကို စာရွက်စာတမ်းတင်ထားပါ။ Admin routes အားလုံးတွင် deny-by-default policy၊ explicit role check၊ request body size limit၊ upload MIME/size validation နှင့် safe filename handling သုံးပါ။ Webhook တွင် signature verification၊ replay protection၊ timestamp tolerance နှင့် allowlist policy ထည့်ပါ။

Error response တွင် stack trace၊ database details၊ provider token သို့မဟုတ် internal path မပြပါနှင့်။ Structured logger ကို request ID၊ actor ID၊ action၊ result နှင့် latency fields ဖြင့် သုံးပါ။ Sensitive fields များကို redaction policy ဖြင့် mask လုပ်ပါ။

### ၁၄။ Backup/restore ကို regularly verify လုပ်ပါ

Backup ထုတ်နိုင်ခြင်းတစ်ခုတည်း မလုံလောက်ပါ။ Scheduled restore drill၊ checksum၊ encryption key rotation၊ retention policy နှင့် restore RTO/RPO ကို စမ်းသပ်ပါ။ Restore test မအောင်မြင်လျှင် alert ထုတ်ပြီး operator guide တွင် step-by-step procedure ထည့်ပါ။

### ၁၅။ Health checks နှင့် observability တိုးပါ

API အတွက် liveness နှင့် readiness endpoints ခွဲပါ။ Readiness တွင် database connectivity၊ required provider configuration နှင့် migration state ကို စစ်ပါ။ Bot အတွက် last update time၊ cron job last success၊ queue backlog၊ provider error count နှင့် database latency ကို metric အဖြစ် စောင့်ကြည့်ပါ။ PM2 restart count တစ်ခုတည်းကို health အဖြစ် မယူဆသင့်ပါ။

## အကောင်အထည်ဖော်ရန် ၄ ဆင့် roadmap

### Phase A — ၁ ရက်မှ ၂ ရက်: Build နှင့် security baseline

Dependency patching၊ pnpm version pinning၊ clean install fix၊ `.env.example` update၊ secret scan၊ `lint/typecheck/test/build` root scripts နှင့် CI skeleton ကို အရင်လုပ်ပါ။ ဤ phase ပြီးချိန်တွင် clean checkout တစ်ခုမှ CI green ဖြစ်ရမည်။

### Phase B — ၃ ရက်မှ ၁ ပတ်: Test နှင့် boundary

Config validation၊ global error format၊ API contract test၊ webhook idempotency test၊ wallet/referral critical-path test နှင့် permission matrix test ထည့်ပါ။ ကြီးမားသော admin/store routes ထဲမှ feature တစ်ခုကို use-case/service/repository layer သို့ pilot refactor လုပ်ပြီး pattern အဖြစ်သတ်မှတ်ပါ။

### Phase C — ၁ ပတ်မှ ၃ ပတ်: Incremental TypeScript နှင့် refactor

Shared types/config/logger ကို package အဖြစ် သတ်မှတ်ပြီး bot ၏ utility နှင့် service အချို့ကို TypeScript သို့ ရွှေ့ပါ။ ၁,၀၀၀ lines ကျော်သော file များကို feature boundary အလိုက် ခွဲပါ။ တစ်ကြိမ်လျှင် feature တစ်ခုသာ ပြောင်းပြီး regression tests ဖြင့် ကာကွယ်ပါ။

### Phase D — ဆက်လက်လုပ်ဆောင်ရန်: Operations နှင့် performance

Restore drills၊ metrics၊ alerting၊ API latency budget၊ frontend code-splitting၊ dependency update cadence နှင့် quarterly security review ကို ထည့်ပါ။ Feature အသစ်တိုင်းသည် validation၊ authorization၊ audit log၊ test နှင့် rollback impact တို့ကို PR template ထဲတွင် ဖြည့်ရမည်။

## PR checklist အကြံပြုချက်

```text
[ ] Input schema/validation ထည့်ထားပါသလား
[ ] Authorization/role policy စစ်ထားပါသလား
[ ] Money-like state သည် idempotent/atomic ဖြစ်ပါသလား
[ ] Audit log သို့မဟုတ် operational event လိုပါသလား
[ ] Unit/integration/E2E test ထည့်ထားပါသလား
[ ] Error path နှင့် empty/loading state စစ်ထားပါသလား
[ ] Secrets/logging/PII exposure မရှိပါသလား
[ ] Migration/rollback impact စဉ်းစားထားပါသလား
[ ] Documentation နှင့် .env.example update လုပ်ထားပါသလား
[ ] lint/typecheck/test/build/audit အားလုံး pass ဖြစ်ပါသလား
```

## အဆုံးသတ်အကြံပြုချက်

ဒီ repository ကို တစ်ခါတည်း rewrite လုပ်ရန် မလိုပါ။ အကောင်းဆုံးလမ်းကြောင်းမှာ **လုံခြုံရေးနှင့် reproducible build ကို အရင်တည်ငြိမ်စေခြင်း၊ critical business paths များကို test ဖြင့်ကာကွယ်ခြင်း၊ ထို့နောက် boundary ကောင်းသော module များကို incremental TypeScript သို့ ရွှေ့ခြင်း** ဖြစ်သည်။ Code quality တိုးတက်မှု၏ အောင်မြင်မှုကို file count သို့မဟုတ် type coverage တစ်ခုတည်းဖြင့် မတိုင်းဘဲ CI reliability၊ regression rate၊ recovery time နှင့် production incident အရေအတွက်ဖြင့် တိုင်းတာသင့်သည်။

## References

[1]: https://pnpm.io/continuous-integration 'pnpm — Continuous Integration'
[2]: https://docs.github.com/en/actions 'GitHub Actions Documentation'
[3]: https://owasp.org/www-project-application-security-verification-standard/ 'OWASP Application Security Verification Standard'
[4]: https://www.typescriptlang.org/tsconfig 'TypeScript TSConfig Reference'
[5]: https://nodejs.org/api/test.html 'Node.js Test Runner Documentation'
