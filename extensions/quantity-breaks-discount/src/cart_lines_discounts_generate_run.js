import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from '../generated/api';


/**
  * @typedef {import("../generated/api").CartInput} RunInput
  * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
  */

/**
  * @param {RunInput} input
  * @returns {CartLinesDiscountsGenerateRunResult}
  */

export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return {operations: []};
  }

  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  if (!hasProductDiscountClass) {
    return {operations: []};
  }

  const variantBuckets = new Map();

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (merchandise?.__typename !== "ProductVariant") continue;

    const variantId = merchandise.id;
    const rawTiers = merchandise.product?.quantityBreaks?.jsonValue;
    const tiers = Array.isArray(rawTiers)
      ? rawTiers
          .map((tier) => {
            const title = String(tier?.title || "").trim();
            const minQuantity = Number.parseInt(String(tier?.min_quantity ?? "").trim(), 10);
            const percentOff = Number.parseFloat(String(tier?.percent_off ?? "").trim());

            if (!title) return null;
            if (!Number.isInteger(minQuantity) || minQuantity <= 0) return null;
            if (!Number.isFinite(percentOff) || percentOff <= 0 || percentOff > 100) return null;

            return {
              title,
              minQuantity,
              percentOff,
            };
          })
          .filter(Boolean)
      : [];

    if (!tiers.length) continue;

    const bucket = variantBuckets.get(variantId) || {
      quantity: 0,
      lines: [],
      tiers,
    };

    bucket.quantity += line.quantity || 0;
    bucket.lines.push(line);
    variantBuckets.set(variantId, bucket);
  }

  const candidates = [];

  for (const bucket of variantBuckets.values()) {
    const eligibleTier = bucket.tiers
      .filter((tier) => bucket.quantity >= tier.minQuantity)
      .sort((left, right) => right.minQuantity - left.minQuantity)[0];

    if (!eligibleTier) continue;

    for (const line of bucket.lines) {
      candidates.push({
        message: eligibleTier.title,
        targets: [
          {
            cartLine: {
              id: line.id,
            },
          },
        ],
        value: {
          percentage: {
            value: eligibleTier.percentOff,
          },
        },
      });
    }
  }

  if (!candidates.length) {
    return {operations: []};
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
