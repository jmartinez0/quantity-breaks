import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import {
  getRuleProductIds,
  parseDiscountConfig,
  recomputeProductDiscountProjectionMetafields,
} from "./quantity-breaks.server";

const QUANTITY_BREAKS_FUNCTION_HANDLE = "quantity-breaks-discount";
const QUANTITY_BREAKS_DISCOUNT_TITLE = "Quantity Breaks";

const ensureQuantityBreaksMetafield = async (admin) => {
  try {
    const shopResponse = await admin.graphql(
      `#graphql
        query SetMetafieldGetShop {
          shop {
            id
            metafield(namespace: "quantity_breaks", key: "discounts") {
              id
            }
          }
        }
      `,
    );

    const shopJson = await shopResponse.json();
    const shopId = shopJson.data?.shop?.id;
    const metafieldId = shopJson.data?.shop?.metafield?.id;

    if (!shopId || metafieldId) return;

    const setResponse = await admin.graphql(
      `#graphql
        mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: {
          metafields: [
            {
              ownerId: shopId,
              namespace: "quantity_breaks",
              key: "discounts",
              type: "json",
              value: JSON.stringify({ discounts: [] }),
            },
          ],
        },
      },
    );

    const setJson = await setResponse.json();
    const errors = setJson.data?.metafieldsSet?.userErrors || [];
    if (errors.length > 0) {
      console.error("Failed to bootstrap quantity_breaks.discounts metafield", errors);
    }
  } catch (error) {
    console.error("afterAuth metafield bootstrap failed", error);
  }
};

const refreshQuantityBreaksProductMetafields = async (admin) => {
  try {
    const response = await admin.graphql(
      `#graphql
        query QuantityBreaksRefreshProductMetafields {
          shop {
            metafield(namespace: "quantity_breaks", key: "discounts") {
              value
            }
          }
        }
      `,
    );

    const json = await response.json();
    const config = parseDiscountConfig(json.data?.shop?.metafield?.value);
    const affectedProductIds = Array.from(
      new Set(
        (config.discounts || []).flatMap((discount) => getRuleProductIds(discount)),
      ),
    );

    await recomputeProductDiscountProjectionMetafields({
      admin,
      discounts: config.discounts || [],
      affectedProductIds,
    });
  } catch (error) {
    console.error("afterAuth quantity breaks product projection refresh failed", error);
  }
};

const ensureQuantityBreaksAutomaticAppDiscount = async (admin) => {
  try {
    const checkQuery = `
      query {
        discountNodes(query: "title:'${QUANTITY_BREAKS_DISCOUNT_TITLE}'", first: 5) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp {
                title
                status
              }
            }
          }
        }
      }
    `;

    const checkRes = await admin.graphql(checkQuery);
    const checkJson = await checkRes.json();

    if (checkJson.errors?.length) {
      console.error(
        "Error querying for existing Quantity Breaks discount:",
        checkJson.errors,
      );
    }

    const nodes = checkJson?.data?.discountNodes?.nodes ?? [];
    const exists = nodes.some(
      (node) => node.discount?.title === QUANTITY_BREAKS_DISCOUNT_TITLE,
    );

    if (exists) {
      console.log("Quantity Breaks automatic discount already exists.");
      return;
    }

    const createMutation = `
      mutation discountAutomaticAppCreate(
        $automaticAppDiscount: DiscountAutomaticAppInput!
      ) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            discountId
            title
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const automaticAppDiscount = {
      title: QUANTITY_BREAKS_DISCOUNT_TITLE,
      functionHandle: QUANTITY_BREAKS_FUNCTION_HANDLE,
      discountClasses: ["PRODUCT"],
      startsAt: new Date(Date.now() + 5000).toISOString(),
      combinesWith: {
        productDiscounts: true,
        orderDiscounts: true,
        shippingDiscounts: true,
      },
    };

    const createRes = await admin.graphql(createMutation, {
      variables: { automaticAppDiscount },
    });

    const createJson = await createRes.json();
    console.dir(createJson, { depth: null });

    if (createJson.errors?.length) {
      console.error(
        "GraphQL-level errors from discountAutomaticAppCreate:",
        createJson.errors,
      );
      return;
    }

    const payload = createJson.data?.discountAutomaticAppCreate;

    if (!payload) {
      console.error(
        "discountAutomaticAppCreate returned no data. Full response:",
        createJson,
      );
      return;
    }

    if (payload.userErrors.length > 0) {
      console.error(
        "Failed to create Quantity Breaks automatic discount (userErrors):",
        payload.userErrors,
      );
    } else {
      console.log(
        "Quantity Breaks automatic discount created successfully:",
        payload.automaticAppDiscount,
      );
    }
  } catch (error) {
    console.error("afterAuth quantity breaks discount bootstrap failed", error);
  }
};

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  hooks: {
    afterAuth: async ({ admin }) => {
      await ensureQuantityBreaksMetafield(admin);
      await refreshQuantityBreaksProductMetafields(admin);
      await ensureQuantityBreaksAutomaticAppDiscount(admin);
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
