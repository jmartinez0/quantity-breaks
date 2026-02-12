export const QUANTITY_BREAKS_NAMESPACE = "quantity_breaks";
export const QUANTITY_BREAKS_KEY = "discounts";
export const QUANTITY_BREAKS_TYPE = "json";

const MAX_METAFIELDS_SET = 25;

export const parseDiscountConfig = (value) => {
  if (!value) return { discounts: [] };

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return { discounts: [] };
    if (!Array.isArray(parsed.discounts)) return { discounts: [] };
    return parsed;
  } catch {
    return { discounts: [] };
  }
};

export const normalizeProductId = (product) => {
  if (typeof product === "string" && product.startsWith("gid://shopify/Product/")) {
    return product;
  }

  if (
    product &&
    typeof product === "object" &&
    typeof product.id === "string" &&
    product.id.startsWith("gid://shopify/Product/")
  ) {
    return product.id;
  }

  return "";
};

export const normalizeProductIds = (products) =>
  Array.from(
    new Set(
      (Array.isArray(products) ? products : [])
        .map((product) => normalizeProductId(product))
        .filter(Boolean),
    ),
  );

export const getRuleProductIds = (rule = {}) => {
  const directProductIds = normalizeProductIds(rule.products);
  if (directProductIds.length > 0) return directProductIds;

  const seenIds = new Set();
  const productIdsFromTiers = [];
  for (const tier of Array.isArray(rule.tiers) ? rule.tiers : []) {
    for (const productId of normalizeProductIds(tier?.products)) {
      if (seenIds.has(productId)) continue;
      seenIds.add(productId);
      productIdsFromTiers.push(productId);
    }
  }

  return productIdsFromTiers;
};

const normalizeTierForProjection = (tier = {}) => {
  const minQuantity = Number.parseInt(String(tier?.min_quantity ?? "").trim(), 10);
  const percentOff = Number(String(tier?.percent_off ?? "").trim());

  if (!Number.isInteger(minQuantity) || minQuantity <= 0) return null;
  if (!Number.isFinite(percentOff) || percentOff < 0 || percentOff > 100) return null;

  return {
    min_quantity: minQuantity,
    percent_off: percentOff,
  };
};

const buildProductTierProjection = (discounts, productId) => {
  const byMinQuantity = new Map();

  for (const rule of Array.isArray(discounts) ? discounts : []) {
    const ruleProductIds = getRuleProductIds(rule);
    if (!ruleProductIds.includes(productId)) continue;

    for (const tier of Array.isArray(rule?.tiers) ? rule.tiers : []) {
      const normalizedTier = normalizeTierForProjection(tier);
      if (!normalizedTier) continue;

      const existing = byMinQuantity.get(normalizedTier.min_quantity);
      if (!existing || normalizedTier.percent_off > existing.percent_off) {
        byMinQuantity.set(normalizedTier.min_quantity, normalizedTier);
      }
    }
  }

  return Array.from(byMinQuantity.values()).sort(
    (left, right) => left.min_quantity - right.min_quantity,
  );
};

const chunkArray = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

export const recomputeProductDiscountProjectionMetafields = async ({
  admin,
  discounts,
  affectedProductIds,
}) => {
  const productIds = normalizeProductIds(affectedProductIds);
  if (productIds.length === 0) return [];

  const metafieldsToSet = [];

  for (const productId of productIds) {
    const projectedTiers = buildProductTierProjection(discounts, productId);
    const targetValue = projectedTiers.length > 0 ? JSON.stringify(projectedTiers) : "[]";

    metafieldsToSet.push({
      ownerId: productId,
      namespace: QUANTITY_BREAKS_NAMESPACE,
      key: QUANTITY_BREAKS_KEY,
      type: QUANTITY_BREAKS_TYPE,
      value: targetValue,
    });
  }

  const errors = [];
  for (const metafieldChunk of chunkArray(metafieldsToSet, MAX_METAFIELDS_SET)) {
    const response = await admin.graphql(
      `#graphql
        mutation QuantityBreaksSetProductMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      { variables: { metafields: metafieldChunk } },
    );
    const responseJson = await response.json();
    const userErrors = responseJson.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      errors.push(...userErrors.map((error) => error.message));
    }
  }

  return errors;
};
