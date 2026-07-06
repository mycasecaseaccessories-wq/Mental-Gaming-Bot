import { Router, type IRouter } from "express";
import healthRouter        from "./health";
import webhookRouter       from "./webhook";
import storeRouter         from "./store";
import gamificationRouter  from "./gamification";
import supportRouter       from "./support";
import adminRouter         from "./admin";
import promoRouter         from "./promo";
import addressBookRouter   from "./addressBook";
import faqRouter           from "./faq";
import reviewsRouter       from "./reviews";
import rewardsRouter       from "./rewards";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/webhook", webhookRouter);
// Public routers MUST be mounted before storeRouter: storeRouter applies
// telegramAuth as router-level middleware, which would otherwise 401 every
// /store/* request (even ones destined for a later router) before Express can
// fall through to a public route like /faqs.
router.use("/store", faqRouter);
router.use("/store", reviewsRouter);
router.use("/store/rewards", rewardsRouter);
router.use("/store", storeRouter);
router.use("/store", gamificationRouter);
router.use("/store", supportRouter);
router.use("/store", adminRouter);
router.use("/store", promoRouter);
router.use("/store", addressBookRouter);

export default router;
