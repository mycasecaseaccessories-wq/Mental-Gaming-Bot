import { ObjectId } from "mongodb";
import { getCollection } from "./mongodb";

export interface PromoDoc {
  _id: ObjectId;
  code: string;
  discountType: "Flat" | "Percentage";
  value: number;
  maxUses: number | null;
  currentUses: number;
  expiryDate: Date | null;
  minOrderAmount: number;
  usedBy: Array<{ userId: ObjectId; usedAt: Date }>;
  isActive: boolean;
  restrictedToUserId?: ObjectId | null;
  description?: string;
}

export function calcPromoDiscount(promo: PromoDoc, amount: number): number {
  if (promo.discountType === "Flat") return Math.min(promo.value, amount);
  return Math.floor((promo.value / 100) * amount);
}

export interface PromoValidation {
  valid: boolean;
  error?: string;
  promo?: PromoDoc;
  discount?: number;
}

// Mirrors bot PromoService.validatePromo — same rules, same collection.
export async function validatePromo(
  code: string,
  userId: ObjectId,
  amount: number
): Promise<PromoValidation> {
  const promos = await getCollection<PromoDoc>("promos");
  const promo = await promos.findOne({ code: code.toUpperCase().trim() });
  if (!promo) return { valid: false, error: "Invalid promo code." };
  if (!promo.isActive) {
    return { valid: false, error: "This promo code is no longer active." };
  }
  if (promo.restrictedToUserId && promo.restrictedToUserId.toString() !== userId.toString()) {
    return { valid: false, error: "This promo code is not available for your account." };
  }
  if (promo.expiryDate && new Date() > new Date(promo.expiryDate)) {
    return { valid: false, error: "This promo code has expired." };
  }
  if (promo.maxUses !== null && promo.currentUses >= promo.maxUses) {
    return { valid: false, error: "This promo code has reached its usage limit." };
  }
  if (promo.usedBy?.some((u) => u.userId?.toString() === userId.toString())) {
    return { valid: false, error: "You have already used this promo code." };
  }
  if (amount < (promo.minOrderAmount || 0)) {
    return {
      valid: false,
      error: `Minimum order amount for this promo is ${(promo.minOrderAmount || 0).toLocaleString()} KS.`,
    };
  }
  return { valid: true, promo, discount: calcPromoDiscount(promo, amount) };
}
