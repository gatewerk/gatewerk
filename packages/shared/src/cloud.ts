// packages/shared/src/cloud.ts

export const SUBSCRIPTION_PLANS = ["trial", "solo", "community", "team", "business"] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "expired",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const PLAN_LIMITS = {
  trial: {
    name: "Free Trial",
    price: 0,
    trialDays: 30,
    reviewLimit: Infinity,
    templateLimit: Infinity,
    apiKeyLimit: Infinity,
  },
  solo: {
    name: "Solo",
    price: 600, // cents — $6/mo
    trialDays: 0,
    reviewLimit: Infinity,
    templateLimit: Infinity,
    apiKeyLimit: Infinity,
  },
  community: {
    name: "Community",
    price: 0,
    trialDays: 0,
    reviewLimit: Infinity,
    templateLimit: Infinity,
    apiKeyLimit: Infinity,
  },
  team: {
    name: "Team",
    price: 4900, // $49 / mo
    trialDays: 30,
    reviewLimit: Infinity, // overage handled by Stripe Billing Meters
    templateLimit: Infinity,
    apiKeyLimit: Infinity,
  },
  business: {
    name: "Business",
    price: 14900, // $149 / mo
    trialDays: 0,
    reviewLimit: Infinity, // overage handled by Stripe Billing Meters
    templateLimit: Infinity,
    apiKeyLimit: Infinity,
  },
} as const satisfies Record<SubscriptionPlan, {
  name: string;
  price: number;
  trialDays: number;
  reviewLimit: number;
  templateLimit: number;
  apiKeyLimit: number;
}>;

export interface CloudSubscription {
  id: string;
  organizationId: string;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
}
