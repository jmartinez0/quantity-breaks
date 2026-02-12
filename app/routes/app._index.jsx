import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  QUANTITY_BREAKS_KEY,
  QUANTITY_BREAKS_NAMESPACE,
  getRuleProductIds,
  normalizeProductIds,
  parseDiscountConfig,
  recomputeProductDiscountProjectionMetafields,
} from "../quantity-breaks.server";

const toKebabCase = (value) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

const getProductImageUrl = (product) =>
  product?.images?.[0]?.originalSrc ||
  product?.images?.[0]?.url ||
  product?.featuredImage?.url ||
  product?.image?.src ||
  "";

const getProductNumericId = (productGid) => {
  if (typeof productGid !== "string") return "";
  const parts = productGid.split("/");
  return parts[parts.length - 1] || "";
};

const buildExcludeProductsQuery = (products) =>
  products
    .map((product) => getProductNumericId(product?.id))
    .filter(Boolean)
    .map((id) => `-id:${id}`)
    .join(" ");

const getTierDisplayTitle = (tier) => tier?.title || tier?.label || "Untitled discount";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query QuantityBreaksHomeData {
        shop {
          id
          metafield(namespace: "quantity_breaks", key: "discounts") {
            value
          }
        }
      }
    `,
  );

  const responseJson = await response.json();
  const metafieldValue = responseJson.data?.shop?.metafield?.value;
  const config = parseDiscountConfig(metafieldValue);

  const rows = (config.discounts || []).map((discount) => ({
    title: discount.title || "Untitled",
    handle: toKebabCase(discount.title || "untitled"),
    tierTitles: (discount.tiers || []).map((tier) => getTierDisplayTitle(tier)),
  }));

  return { rows };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("_action") !== "add-discount") {
    return { ok: false, errors: ["Unknown action"] };
  }

  const title = String(formData.get("title") || "").trim();
  const discountTitle = String(formData.get("discountTitle") || "").trim();
  const minimumQuantity = Number.parseInt(String(formData.get("minimumQuantity") || "0"), 10);
  const percentOff = Number.parseInt(String(formData.get("percentOff") || "0"), 10);

  let selectedProducts = [];
  try {
    selectedProducts = JSON.parse(String(formData.get("selectedProducts") || "[]"));
    if (!Array.isArray(selectedProducts)) selectedProducts = [];
  } catch {
    selectedProducts = [];
  }

  const productIds = selectedProducts
    .map((product) => product?.id);
  const normalizedProductIds = normalizeProductIds(productIds);

  const errors = [];
  if (!title) errors.push("Title is required.");
  if (!discountTitle) errors.push("Discount title is required.");
  if (!Number.isInteger(minimumQuantity) || minimumQuantity < 1) {
    errors.push("Minimum product quantity must be a whole number greater than 0.");
  }
  if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 100) {
    errors.push("Percent off must be a whole number between 1 and 100.");
  }
  if (normalizedProductIds.length === 0) errors.push("Select at least one product.");

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const shopResponse = await admin.graphql(
    `#graphql
      query QuantityBreaksShopMeta {
        shop {
          id
          metafield(namespace: "quantity_breaks", key: "discounts") {
            value
          }
        }
      }
    `,
  );

  const shopJson = await shopResponse.json();
  const shopId = shopJson.data?.shop?.id;
  const currentConfig = parseDiscountConfig(shopJson.data?.shop?.metafield?.value);

  const discountResponse = await admin.graphql(
    `#graphql
      mutation CreateQuantityBreakAutomaticDiscount($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
        discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
          automaticDiscountNode {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        automaticBasicDiscount: {
          title: discountTitle,
          startsAt: new Date().toISOString(),
          combinesWith: {
            productDiscounts: true,
            orderDiscounts: true,
            shippingDiscounts: true,
          },
          minimumRequirement: {
            quantity: {
              greaterThanOrEqualToQuantity: String(minimumQuantity),
            },
          },
          customerGets: {
            value: {
              percentage: percentOff / 100,
            },
            items: {
                products: {
                  productsToAdd: normalizedProductIds,
                },
              },
            appliesOnOneTimePurchase: true,
            appliesOnSubscription: false,
          },
        },
      },
    },
  );

  const discountJson = await discountResponse.json();
  const discountErrors = discountJson.data?.discountAutomaticBasicCreate?.userErrors || [];

  if (discountErrors.length > 0) {
    return {
      ok: false,
      errors: discountErrors.map((error) => error.message),
    };
  }

  const discountId = discountJson.data?.discountAutomaticBasicCreate?.automaticDiscountNode?.id;
  const newTier = {
    min_quantity: minimumQuantity,
    percent_off: percentOff,
    title: discountTitle,
    discount_id: discountId,
  };

  const nextDiscounts = [...(currentConfig.discounts || [])];
  const existingIndex = nextDiscounts.findIndex((discount) => discount?.title === title);
  const previousRuleProductIds =
    existingIndex >= 0 ? getRuleProductIds(nextDiscounts[existingIndex]) : [];
  const existingRuleStatus =
    existingIndex >= 0 && nextDiscounts[existingIndex]?.status === "inactive"
      ? "inactive"
      : "active";

  if (existingRuleStatus === "inactive" && discountId) {
    await admin.graphql(
      `#graphql
        mutation DeactivateQuantityBreakTier($id: ID!) {
          discountAutomaticDeactivate(id: $id) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      { variables: { id: discountId } },
    );
  }

  if (existingIndex >= 0) {
    const currentTiers = Array.isArray(nextDiscounts[existingIndex].tiers)
      ? nextDiscounts[existingIndex].tiers
      : [];
    nextDiscounts[existingIndex] = {
      ...nextDiscounts[existingIndex],
      title,
      products: normalizedProductIds,
      status: nextDiscounts[existingIndex]?.status || "active",
      tiers: [...currentTiers, newTier],
    };
  } else {
    nextDiscounts.push({
      title,
      products: normalizedProductIds,
      status: "active",
      tiers: [newTier],
    });
  }

  const nextConfig = { discounts: nextDiscounts };

  const metafieldSetResponse = await admin.graphql(
    `#graphql
      mutation SetShopQuantityBreaksMetafield($metafields: [MetafieldsSetInput!]!) {
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
            namespace: QUANTITY_BREAKS_NAMESPACE,
            key: QUANTITY_BREAKS_KEY,
            type: "json",
            value: JSON.stringify(nextConfig),
          },
        ],
      },
    },
  );

  const metafieldSetJson = await metafieldSetResponse.json();
  const metafieldErrors = metafieldSetJson.data?.metafieldsSet?.userErrors || [];

  if (metafieldErrors.length > 0) {
    return {
      ok: false,
      errors: metafieldErrors.map((error) => error.message),
    };
  }

  const affectedProductIds = Array.from(
    new Set([...previousRuleProductIds, ...normalizedProductIds]),
  );
  const projectionErrors = await recomputeProductDiscountProjectionMetafields({
    admin,
    discounts: nextDiscounts,
    affectedProductIds,
  });
  if (projectionErrors.length > 0) {
    return { ok: false, errors: projectionErrors };
  }

  return { ok: true };
};

export default function QuantityBreaksIndexPage() {
  const { rows } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const addDiscountModalRef = useRef(null);

  const [title, setTitle] = useState("");
  const [discountTitle, setDiscountTitle] = useState("");
  const [minimumQuantity, setMinimumQuantity] = useState("");
  const [percentOff, setPercentOff] = useState("");
  const [selectedProducts, setSelectedProducts] = useState([]);

  const selectedProductsJson = useMemo(
    () =>
      JSON.stringify(
        selectedProducts.map((product) => ({
          id: product.id,
          title: product.title,
          image: product.image || "",
        })),
      ),
    [selectedProducts],
  );

  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.ok) {
      shopify.toast.show("Discount added");
      setTitle("");
      setDiscountTitle("");
      setMinimumQuantity("");
      setPercentOff("");
      setSelectedProducts([]);
      addDiscountModalRef.current?.hideOverlay?.();
      return;
    }

    if (Array.isArray(fetcher.data.errors) && fetcher.data.errors.length > 0) {
      shopify.toast.show(fetcher.data.errors[0], { isError: true });
    }
  }, [fetcher.data, shopify]);

  const openProductPicker = async () => {
    const excludeQuery = buildExcludeProductsQuery(selectedProducts);
    const selection = await shopify.resourcePicker({
      type: "product",
      action: "add",
      multiple: true,
      // Legacy host compatibility: some picker versions still honor showVariants.
      showVariants: false,
      filter: {
        variants: false,
        query: excludeQuery || undefined,
      },
    });

    if (!selection || !Array.isArray(selection)) return;

    setSelectedProducts(
      selection
        .filter((product) => product?.id?.startsWith("gid://shopify/Product/"))
        .map((product) => ({
          id: product.id,
          title: product.title,
          image: getProductImageUrl(product),
        })),
    );
  };

  return (
    <s-page heading="Home" inlineSize="small">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" justifyContent="end">
          <s-button variant="primary" commandFor="add-discount-modal" command="--show">
            Add discount
          </s-button>
        </s-stack>

        <s-section padding="none" accessibilityLabel="Quantity breaks table">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Title</s-table-header>
              <s-table-header>Discounts</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.handle} clickDelegate={`rule-link-${row.handle}`}>
                  <s-table-cell>
                    <s-link id={`rule-link-${row.handle}`} href={`/app/${row.handle}`}>
                      {row.title}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <ul style={{ paddingLeft: 12 }}>
                      {row.tierTitles.map((tierTitle) => (
                        <li key={`${row.handle}-${tierTitle}`}>{tierTitle}</li>
                      ))}
                    </ul>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>

        <s-modal ref={addDiscountModalRef} id="add-discount-modal" heading="Add discount">
        <fetcher.Form id="add-discount-form" method="post">
          <input type="hidden" name="_action" value="add-discount" />
          <input type="hidden" name="selectedProducts" value={selectedProductsJson} />

          <s-stack gap="base">
            <s-text-field
              label="Title"
              name="title"
              value={title}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
            <s-text-field
              label="Discount title"
              name="discountTitle"
              value={discountTitle}
              onInput={(event) => setDiscountTitle(event.currentTarget.value)}
            />
            <s-number-field
              label="Minimum product quantity"
              name="minimumQuantity"
              value={minimumQuantity}
              onInput={(event) => setMinimumQuantity(event.currentTarget.value)}
            />
            <s-number-field
              label="Percent off"
              name="percentOff"
              value={percentOff}
              onInput={(event) => setPercentOff(event.currentTarget.value)}
            />
            <s-stack gap="small">
              <s-heading>Applies to products</s-heading>
              <s-button variant="secondary" onClick={openProductPicker}>
                Browse
              </s-button>
              {selectedProducts.length > 0 && (
                <ul>
                  {selectedProducts.map((product) => (
                    <li key={product.id}>{product.title}</li>
                  ))}
                </ul>
              )}
            </s-stack>
          </s-stack>
        </fetcher.Form>

        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="add-discount-modal"
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={fetcher.state === "submitting"}
          onClick={() => {
            const formElement = document.getElementById("add-discount-form");
            if (formElement instanceof HTMLFormElement) {
              formElement.requestSubmit();
            }
          }}
        >
          Save
        </s-button>
        </s-modal>

      </s-stack>
    </s-page>
  );
}
