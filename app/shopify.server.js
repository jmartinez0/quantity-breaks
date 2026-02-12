import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

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
