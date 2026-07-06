import { initDataString } from "./telegram";

const API_BASE = (import.meta.env.VITE_API_URL ?? "") + "/api/store";

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const initData = initDataString();
  if (initData) headers.set("X-Telegram-Init-Data", initData);

  // Dev-mode fallback when running in plain browser preview outside Telegram.
  if (!initData && import.meta.env.DEV) {
    const devId = localStorage.getItem("dev-telegram-id");
    const devName = localStorage.getItem("dev-telegram-name");
    if (devId) {
      headers.set("X-Dev-Telegram-Id", devId);
      if (devName) headers.set("X-Dev-Telegram-Name", devName);
    }
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }

  if (!res.ok) {
    const msg = (data && typeof data === "object" && "error" in (data as Record<string, unknown>))
      ? String((data as Record<string, unknown>)["error"])
      : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

async function download(path: string, fallbackName: string): Promise<void> {
  const headers = new Headers();
  const initData = initDataString();
  if (initData) headers.set("X-Telegram-Init-Data", initData);
  if (!initData && import.meta.env.DEV) {
    const devId = localStorage.getItem("dev-telegram-id");
    const devName = localStorage.getItem("dev-telegram-name");
    if (devId) {
      headers.set("X-Dev-Telegram-Id", devId);
      if (devName) headers.set("X-Dev-Telegram-Name", devName);
    }
  }

  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data && typeof data === "object" && "error" in data) msg = String(data.error);
    } catch { /* noop */ }
    throw new ApiError(msg, res.status);
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const name = match?.[1] ?? fallbackName;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get:      <T>(p: string)                    => request<T>(p),
  post:     <T>(p: string, body: unknown)     => request<T>(p, { method: "POST",  body: JSON.stringify(body) }),
  put:      <T>(p: string, body: unknown)     => request<T>(p, { method: "PUT",   body: JSON.stringify(body) }),
  patch:    <T>(p: string, body: unknown)     => request<T>(p, { method: "PATCH", body: JSON.stringify(body) }),
  del:      <T>(p: string)                    => request<T>(p, { method: "DELETE" }),
  postForm: <T>(p: string, form: FormData)    => request<T>(p, { method: "POST",  body: form }),
  download,
};

// ── Types ─────────────────────────────────────────────────────────────────
export interface Me {
  id: string;
  telegramId: number;
  username: string | null;
  firstName: string | null;
  balanceKS: number;
  balanceCoin: number;
  totalDeposited: number;
  tier: "Silver" | "Gold" | "Platinum";
  language: "en" | "mm";
  theme: "light" | "dark" | "auto";
  photoUrl: string | null;
  tierDiscountPct: number;
  lifetimeTier: "Bronze" | "Silver" | "Gold" | "Platinum" | "Diamond";
  activeTier: "Bronze" | "Silver" | "Gold" | "Platinum" | "Diamond";
  lifetimeSpend: number;
  yearlySpend: number;
}

export interface Banner {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  targetType: "shop" | "category" | "product" | "url" | "none";
  targetId: string | null;
  buttonText: string | null;
  endAt: string | null;
  priority: number;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  imageUrl: string | null;
  targetType: string;
  targetId: string | null;
  isRead: boolean;
  at: string | null;
}

export interface NotificationsResponse {
  unreadCount: number;
  notifications: Notification[];
}

export interface PopularResponse {
  popular: Product[];
  recent: Product[];
}

export interface FeatureGates {
  totalUsers: number;
  unlockTarget: number;
  allUnlocked: boolean;
  gates: Record<string, boolean>;
}

export interface McConfig {
  enabled: boolean;
  exchangeRate: number;
  minRedeem: number;
  maxDiscountPct: number;
}

export interface CheckoutField {
  key: string;
  label: string;
  fieldType: "text" | "number" | "email" | "textarea";
  required: boolean;
  placeholder?: string;
  helpText?: string;
  sortOrder?: number;
}

export interface CheckoutDataEntry {
  key: string;
  label: string;
  value: string;
}

export interface Catalog {
  id: string;
  name: string;
  imageUrl: string | null;
  sortOrder: number;
  parentCategoryId: string | null;
  checkoutFields: CheckoutField[];
  productCount: number;
  subCatalogs?: Catalog[];
}

export interface CatalogDetail {
  id: string;
  name: string;
  imageUrl: string | null;
  checkoutFields: CheckoutField[];
  subCatalogs: Catalog[];
  products: Product[];
}

export interface Product {
  id: string;
  name: string;
  category: string;
  region: string;
  productType: "DirectTopup" | "DigitalCode";
  price: number;
  effectivePrice: number;
  onSale: boolean;
  flashSaleEnd: string | null;
  inStock: boolean;
  imageUrl: string | null;
  description: string;
  catalogId: string | null;
  sortOrder: number;
  checkoutFields: CheckoutField[] | null;
  status: "active" | "out_of_stock" | "coming_soon" | "hidden";
}

export interface Category { name: string; count: number; }

export interface ShopResponse { products: Product[]; categories: Category[]; }
export interface CatalogsResponse { catalogs: Catalog[]; }

export type OrderStatus = "Pending" | "Processing" | "Success" | "Cancelled" | "Refunded";

export interface OrderSummary {
  id: string;
  shortId: string;
  productName: string;
  productImage: string | null;
  amount: number;
  status: OrderStatus;
  gameId: string | null;
  zoneId: string | null;
  checkoutData?: CheckoutDataEntry[];
  quantity?: number;
  timestamp: string;
}

export interface OrderDetail {
  id: string;
  shortId: string;
  product: Product | null;
  amount: number;
  originalAmount: number | null;
  tierDiscount: number;
  status: OrderStatus;
  gameId: string | null;
  zoneId: string | null;
  checkoutData?: CheckoutDataEntry[];
  quantity?: number;
  unitPrice?: number | null;
  catalogName?: string | null;
  timestamp: string;
  notes: string;
}

export interface WalletResponse {
  balanceKS: number;
  balanceCoin: number;
  tier: "Silver" | "Gold" | "Platinum";
  totalDeposited: number;
  history: {
    id: string;
    type: string;
    wallet: "KS" | "Coin";
    amount: number;
    status: string;
    paymentMethod: string | null;
    description: string | null;
    at: string | null;
  }[];
}

export interface PaymentMethod {
  id: string;
  label: string;
  shortCode?: string;
  emoji?: string;
  accountName: string;
  accountNumber: string;
  status?: "Online" | "Busy" | "Offline";
}

export interface PromoPreview {
  code: string;
  discountType: "Flat" | "Percentage";
  value: number;
  discount: number;
  minOrderAmount: number;
  description: string;
}

export interface SavedAddress {
  id: string;
  gameName: string;
  gameId: string;
  zoneId: string | null;
  nickname: string | null;
  isDefault: boolean;
}

export interface Faq {
  faqId: string;
  question: string;
  answer: string;
  tags: string[];
  category: string;
  videoUrl: string | null;
  videoCaption: string | null;
  viewCount: number;
}

export interface PublicReview {
  id: string;
  rating: number;
  comment: string;
  productName: string;
  author: string;
  createdAt: string | null;
}

export interface ReviewStats {
  avgRating: number;
  rated: number;
  fiveStars: number;
}

export interface MyReview {
  orderId: string;
  productName: string;
  rating: number | null;
  comment: string | null;
  isPublic: boolean;
  createdAt: string | null;
}

export interface RatableOrder {
  orderId: string;
  productName: string;
  date: string | null;
}

// ── Coin Rewards & Redeem Codes ─────────────────────────────────────────────
export interface RewardCouponSummary {
  discountType: "Flat" | "Percentage" | null;
  value: number | null;
  minOrder: number;
}

export interface RewardItem {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  coinPrice: number;
  rewardType: "product" | "coupon";
  productName: string | null;
  coupon: RewardCouponSummary | null;
  checkoutFields: CheckoutField[];
  stockCount: number;
  perUserLimit: number;
  redeemedByUser: number;
  canRedeem: boolean;
}

export interface RewardItemsResponse {
  coinBalance: number;
  items: RewardItem[];
}

export interface RedeemCodePreview {
  code: string;
  description: string;
  rewardType: "product" | "coupon";
  productName: string | null;
  coupon: RewardCouponSummary | null;
  checkoutFields: CheckoutField[];
}

export interface GrantedCoupon {
  code: string;
  discountType: "Flat" | "Percentage";
  value: number;
  minOrderAmount: number;
  expiryDate: string | null;
}

export interface RedeemResult {
  type: "coupon" | "product";
  coupon?: GrantedCoupon;
  order?: { id: string; shortId: string; productName: string; status: string };
  newBalanceCoin?: number;
}
