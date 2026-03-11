import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  QUANTITY_BREAKS_KEY,
  QUANTITY_BREAKS_NAMESPACE,
  getRuleProductIds,
  normalizeStoredTier,
  parseDiscountConfig,
  recomputeProductDiscountProjectionMetafields,
} from "../quantity-breaks.server";

const METAFIELD_NAMESPACE = QUANTITY_BREAKS_NAMESPACE;
const METAFIELD_KEY = QUANTITY_BREAKS_KEY;

const toKebabCase = (value) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

const cloneTiers = (value) =>
  Array.isArray(value) ? value.map((tier) => ({ ...(tier || {}) })) : [];

const cloneProducts = (value) =>
  Array.isArray(value) ? value.map((product) => ({ ...(product || {}) })) : [];

const normalizeProductId = (product) => {
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

const normalizeProductIds = (products) =>
  Array.from(
    new Set(
      (Array.isArray(products) ? products : [])
        .map((product) => normalizeProductId(product))
      .filter(Boolean),
    ),
  );

const getProductImageUrl = (product) =>
  product?.image ||
  product?.images?.[0]?.originalSrc ||
  product?.images?.[0]?.url ||
  product?.featuredImage?.url ||
  product?.image?.src ||
  "";

const normalizeProductForEditor = (product = {}) => {
  const productId = normalizeProductId(product);
  if (!productId) return { id: "", title: "", image: "" };
  if (typeof product === "string") return { id: productId, title: "", image: "" };
  return {
    id: productId,
    title: typeof product.title === "string" ? product.title : "",
    image: getProductImageUrl(product),
  };
};

const normalizeProductsForEditor = (products) =>
  Array.isArray(products)
    ? Array.from(
        products
          .map(normalizeProductForEditor)
          .filter((product) => product.id.startsWith("gid://shopify/Product/"))
          .reduce((acc, product) => {
            if (!acc.has(product.id)) acc.set(product.id, product);
            return acc;
          }, new Map())
          .values(),
      )
    : [];

const getProductNumericId = (productGid) => {
  if (typeof productGid !== "string") return "";
  const parts = productGid.split("/");
  return parts[parts.length - 1] || "";
};

const buildExcludeProductsQuery = (products) => {
  const ids = normalizeProductIds(products)
    .map((productId) => getProductNumericId(productId))
    .filter(Boolean);
  return ids.map((id) => `-id:${id}`).join(" ");
};

const serializeProductIds = (products) => JSON.stringify(normalizeProductIds(products));

const fetchProductSummaries = async (admin, productIds) => {
  if (!Array.isArray(productIds) || productIds.length === 0) return [];

  const response = await admin.graphql(
    `#graphql
      query QuantityBreakProductSummaries($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            featuredImage {
              url
            }
          }
        }
      }
    `,
    { variables: { ids: productIds } },
  );
  const json = await response.json();
  const nodes = Array.isArray(json.data?.nodes) ? json.data.nodes : [];
  const productById = new Map(
    nodes
      .filter((node) => node?.id)
      .map((node) => [
        node.id,
        {
          id: node.id,
          title: node.title || "",
          image: node.featuredImage?.url || "",
        },
      ]),
  );

  return productIds.map((id) => productById.get(id) || { id, title: id, image: "" });
};

const normalizeTierForEditor = (tier = {}) => ({
  title: typeof tier.title === "string" ? tier.title : "",
  min_quantity:
    tier.min_quantity === null || tier.min_quantity === undefined
      ? ""
      : String(tier.min_quantity),
  percent_off:
    tier.percent_off === null || tier.percent_off === undefined
      ? ""
      : String(tier.percent_off),
});

const buildEditorState = (source) => ({
  title: source?.title || "",
  status: source?.status === "inactive" ? "inactive" : "active",
  tiers: Array.isArray(source?.tiers) ? source.tiers.map(normalizeTierForEditor) : [],
  products: normalizeProductsForEditor(source?.products),
});

const cloneEditorState = (state) => ({
  title: state?.title || "",
  status: state?.status === "inactive" ? "inactive" : "active",
  tiers: cloneTiers(state?.tiers || []),
  products: cloneProducts(state?.products || []),
});

const toComparableState = (state) => ({
  title: String(state?.title || "").trim(),
  status: state?.status === "inactive" ? "inactive" : "active",
  tiers: (Array.isArray(state?.tiers) ? state.tiers : []).map((tier) => ({
    title: String(tier?.title || "").trim(),
    min_quantity: String(tier?.min_quantity ?? "").trim(),
    percent_off: String(tier?.percent_off ?? "").trim(),
  })),
  products: normalizeProductIds(state?.products),
});

const editorStatesMatch = (a, b) =>
  JSON.stringify(toComparableState(a)) === JSON.stringify(toComparableState(b));

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query QuantityBreakRuleDetails {
        shop {
          metafield(namespace: "quantity_breaks", key: "discounts") {
            value
          }
        }
      }
    `,
  );

  const responseJson = await response.json();
  const config = parseDiscountConfig(responseJson.data?.shop?.metafield?.value);
  const tableHandle = params.tableHandle || "";

  const rule = (config.discounts || []).find(
    (discount) => toKebabCase(discount?.title || "") === tableHandle,
  );

  if (!rule) {
    return {
      notFound: true,
      title: "Rule not found",
      status: "active",
      tiers: [],
      products: [],
      tableHandle,
    };
  }

  const ruleProductIds = getRuleProductIds(rule);
  const liveProducts = await fetchProductSummaries(admin, ruleProductIds);

  return {
    notFound: false,
    title: rule.title || "Untitled",
    status: rule.status === "inactive" ? "inactive" : "active",
    tiers: Array.isArray(rule.tiers) ? rule.tiers : [],
    products: liveProducts,
    tableHandle,
  };
};

export const action = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = String(formData.get("_action") || "");

  if (!["update-rule-settings", "delete-rule"].includes(actionType)) {
    return { ok: false, errors: ["Unknown action"] };
  }

  if (actionType === "delete-rule") {
    const tableHandle = params.tableHandle || "";

    const shopResponse = await admin.graphql(
      `#graphql
        query DeleteRuleGetShop {
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
    const discounts = [...(currentConfig.discounts || [])];

    const ruleIndex = discounts.findIndex(
      (discount) => toKebabCase(discount?.title || "") === tableHandle,
    );

    if (ruleIndex < 0) {
      return { ok: false, errors: ["Rule not found."] };
    }

    const rule = discounts[ruleIndex] || {};
    const affectedProductIds = getRuleProductIds(rule);
    const nextDiscounts = discounts.filter((_, index) => index !== ruleIndex);

    const setResponse = await admin.graphql(
      `#graphql
        mutation DeleteRuleSetMetafield($metafields: [MetafieldsSetInput!]!) {
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
              namespace: METAFIELD_NAMESPACE,
              key: METAFIELD_KEY,
              type: "json",
              value: JSON.stringify({ discounts: nextDiscounts }),
            },
          ],
        },
      },
    );

    const setJson = await setResponse.json();
    const setErrors = setJson.data?.metafieldsSet?.userErrors || [];
    if (setErrors.length > 0) {
      return {
        ok: false,
        errors: setErrors.map((error) => error.message),
      };
    }

    const projectionErrors = await recomputeProductDiscountProjectionMetafields({
      admin,
      discounts: nextDiscounts,
      affectedProductIds,
    });
    if (projectionErrors.length > 0) {
      return { ok: false, errors: projectionErrors };
    }

    return {
      ok: true,
      actionType: "delete-rule",
      successKey: `delete-rule|${tableHandle}|${Date.now()}`,
      redirectTo: "/app",
    };
  }

  const nextTitle = String(formData.get("title") || "").trim();
  const nextStatus = String(formData.get("status") || "active").trim().toLowerCase();
  const tableHandle = params.tableHandle || "";
  let nextTiers = [];
  let nextProductsInput = [];
  try {
    nextTiers = JSON.parse(String(formData.get("tiers") || "[]"));
    if (!Array.isArray(nextTiers)) nextTiers = [];
  } catch {
    nextTiers = [];
  }
  try {
    nextProductsInput = JSON.parse(String(formData.get("products") || "[]"));
    if (!Array.isArray(nextProductsInput)) nextProductsInput = [];
  } catch {
    nextProductsInput = [];
  }

  if (!nextTitle) {
    return { ok: false, errors: ["Title is required."] };
  }

  if (!["active", "inactive"].includes(nextStatus)) {
    return { ok: false, errors: ["Status must be Active or Inactive."] };
  }

  const nextProductIds = normalizeProductIds(nextProductsInput);
  if (nextProductIds.length === 0) {
    return { ok: false, errors: ["At least one product is required for this rule."] };
  }
  const productIds = nextProductIds;

  const parsedTiers = nextTiers.map((tier) =>
    normalizeStoredTier({
      title: String(tier?.title || "").trim(),
      min_quantity: String(tier?.min_quantity || "").trim(),
      percent_off: String(tier?.percent_off || "").trim(),
    }),
  );
  if (parsedTiers.length === 0) {
    return { ok: false, errors: ["At least one discount tier is required."] };
  }

  const invalidTierIndex = parsedTiers.findIndex((tier) => !tier);

  if (invalidTierIndex >= 0) {
    return {
      ok: false,
      errors: [
        `Tier ${invalidTierIndex + 1} must have a title, minimum quantity (>= 1), and percent discount (0-100).`,
      ],
    };
  }

  nextTiers = parsedTiers.sort((a, b) => a.min_quantity - b.min_quantity);

  const shopResponse = await admin.graphql(
    `#graphql
      query UpdateRuleGetShop {
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
  const discounts = [...(currentConfig.discounts || [])];

  const ruleIndex = discounts.findIndex(
    (discount) => toKebabCase(discount?.title || "") === tableHandle,
  );

  if (ruleIndex < 0) {
    return { ok: false, errors: ["Rule not found."] };
  }

  const rule = discounts[ruleIndex] || {};
  const previousProductIds = getRuleProductIds(rule);
  nextTiers = parsedTiers.sort((a, b) => a.min_quantity - b.min_quantity);

  discounts[ruleIndex] = {
    ...rule,
    title: nextTitle,
    status: nextStatus,
    products: productIds,
    tiers: nextTiers,
  };

  const setResponse = await admin.graphql(
    `#graphql
      mutation UpdateRuleSetMetafield($metafields: [MetafieldsSetInput!]!) {
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
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "json",
            value: JSON.stringify({ discounts }),
          },
        ],
      },
    },
  );

  const setJson = await setResponse.json();
  const setErrors = setJson.data?.metafieldsSet?.userErrors || [];

  if (setErrors.length > 0) {
    return {
      ok: false,
      errors: setErrors.map((error) => error.message),
    };
  }

  const affectedProductIds = Array.from(
    new Set([...previousProductIds, ...productIds]),
  );
  const projectionErrors = await recomputeProductDiscountProjectionMetafields({
    admin,
    discounts,
    affectedProductIds,
  });
  if (projectionErrors.length > 0) {
    return { ok: false, errors: projectionErrors };
  }

  const nextProducts = await fetchProductSummaries(admin, productIds);

  return {
    ok: true,
    actionType: "update-rule-settings",
    successKey: `update-rule-settings|${Date.now()}`,
    nextHandle: toKebabCase(nextTitle),
    nextTitle,
    nextStatus,
    nextProducts,
    nextTiers,
  };
};

export const shouldRevalidate = ({ actionResult, defaultShouldRevalidate }) => {
  if (actionResult?.ok && actionResult?.actionType === "update-rule-settings") return false;
  return defaultShouldRevalidate;
};

export default function QuantityBreakRulePage() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const ruleFormRef = useRef(null);
  const mutationInputRef = useRef(null);
  const tiersInputRef = useRef(null);
  const productsInputRef = useRef(null);
  const lastSuccessKeyRef = useRef("");
  const backHref = "/app";
  const initialState = buildEditorState(data);
  const currentStateRef = useRef(cloneEditorState(initialState));
  const committedStateRef = useRef(cloneEditorState(initialState));
  const [title, setTitle] = useState(initialState.title);
  const [savedHeadingTitle, setSavedHeadingTitle] = useState(initialState.title);
  const [savedTierCount, setSavedTierCount] = useState(initialState.tiers.length);
  const [status, setStatus] = useState(initialState.status);
  const [tiers, setTiers] = useState(initialState.tiers);
  const [products, setProducts] = useState(initialState.products);

  const resetMutationInput = () => {
    const mutationInput = mutationInputRef.current;
    if (!mutationInput) return;
    mutationInput.value = "0";
    mutationInput.defaultValue = "0";
  };

  const handleDeleteRule = () => {
    const deleteData = new FormData();
    deleteData.set("_action", "delete-rule");
    fetcher.submit(deleteData, { method: "post" });
  };

  const showSaveBarNow = () => {
    if (!shopify?.saveBar?.show) return;
    shopify.saveBar.show();
  };

  const triggerFieldSaveBar = (input, nextValue) => {
    const form = ruleFormRef.current;
    if (input) {
      input.value = nextValue;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (form) {
      form.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new Event("change", { bubbles: true }));
    }
    showSaveBarNow();
  };

  const triggerProductsSaveBar = (nextProducts) => {
    triggerFieldSaveBar(productsInputRef.current, serializeProductIds(nextProducts));
  };

  const triggerTiersSaveBar = (nextTiers) => {
    triggerFieldSaveBar(tiersInputRef.current, JSON.stringify(nextTiers));
  };

  const triggerMutationSaveBar = () => {
    const mutationInput = mutationInputRef.current;
    const nextKey = String(Date.now());
    if (mutationInput) {
      mutationInput.defaultValue = "0";
    }
    triggerFieldSaveBar(mutationInput, nextKey);
  };

  const restoreCommittedState = () => {
    const snapshot = cloneEditorState(committedStateRef.current);
    setTitle(snapshot.title);
    setStatus(snapshot.status);
    setTiers(snapshot.tiers);
    setProducts(snapshot.products);
    resetMutationInput();
    currentStateRef.current = snapshot;
  };

  const updateTierField = (index, field, value) => {
    setTiers((current) =>
      current.map((tier, tierIndex) =>
        tierIndex === index
          ? {
              ...tier,
              [field]: value,
            }
          : tier,
      ),
    );
  };

  const handleAddTier = () => {
    setTiers((current) => {
      const next = [
        ...current,
        {
          title: "",
          min_quantity: "",
          percent_off: "",
        },
      ];
      showSaveBarNow();
      return next;
    });
  };

  const handleRemoveTier = (index) => {
    setTiers((current) => {
      if (current.length <= 1) return current;
      const next = current.filter((_, tierIndex) => tierIndex !== index);
      triggerTiersSaveBar(next);
      triggerMutationSaveBar();
      return next;
    });
  };

  const handleRemoveProduct = (productId) => {
    setProducts((current) => {
      if (current.length <= 1) return current;
      const next = current.filter((product) => product.id !== productId);
      triggerProductsSaveBar(next);
      triggerMutationSaveBar();
      return next;
    });
  };

  const handleAddProducts = async () => {
    const excludeQuery = buildExcludeProductsQuery(products);
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

    const selectedProducts = normalizeProductsForEditor(
      selection.map((product) => ({
        id: product?.id,
        title: product?.title,
        image: getProductImageUrl(product),
      })),
    );
    if (selectedProducts.length === 0) return;

    setProducts((current) => {
      const currentIds = new Set(current.map((product) => product.id));
      const mergedById = new Map(current.map((product) => [product.id, product]));
      for (const product of selectedProducts) {
        if (currentIds.has(product.id)) continue;
        mergedById.set(product.id, product);
      }
      const next = Array.from(mergedById.values());
      if (next.length === current.length) return current;
      triggerProductsSaveBar(next);
      triggerMutationSaveBar();
      return next;
    });
  };

  useEffect(() => {
    currentStateRef.current = cloneEditorState({ title, status, tiers, products });
  }, [products, status, tiers, title]);

  useEffect(() => {
    if (!shopify?.saveBar) return;
    const hasUnsavedChanges = !editorStatesMatch(currentStateRef.current, committedStateRef.current);
    if (hasUnsavedChanges) {
      shopify.saveBar.show();
      return;
    }
    shopify.saveBar.hide();
  }, [products, shopify, status, tiers, title]);

  useEffect(() => {
    if (!fetcher.data) return;

    if (fetcher.data.ok) {
      const successKey = fetcher.data.successKey || `${fetcher.data.nextHandle || ""}|${fetcher.data.nextTitle || ""}`;
      if (lastSuccessKeyRef.current !== successKey) {
        const isDelete = fetcher.data.actionType === "delete-rule";
        shopify.toast.show(isDelete ? "Discount deleted" : "Discount updated");
        lastSuccessKeyRef.current = successKey;
      }
      if (fetcher.data.actionType === "delete-rule" && fetcher.data.redirectTo) {
        navigate(fetcher.data.redirectTo, { replace: true });
        return;
      }
      const nextState = buildEditorState({
        title: fetcher.data.nextTitle || currentStateRef.current.title,
        status: fetcher.data.nextStatus || currentStateRef.current.status,
        products: Array.isArray(fetcher.data.nextProducts)
          ? fetcher.data.nextProducts
          : currentStateRef.current.products,
        tiers: Array.isArray(fetcher.data.nextTiers)
          ? fetcher.data.nextTiers
          : currentStateRef.current.tiers,
      });
      setTitle(nextState.title);
      setStatus(nextState.status);
      setProducts(nextState.products);
      setTiers(nextState.tiers);
      resetMutationInput();
      setSavedHeadingTitle(nextState.title);
      setSavedTierCount(nextState.tiers.length);
      currentStateRef.current = cloneEditorState(nextState);
      committedStateRef.current = cloneEditorState(nextState);
      if (shopify?.saveBar?.hide) shopify.saveBar.hide();
      if (fetcher.data.nextHandle && fetcher.data.nextHandle !== data.tableHandle) {
        navigate(`/app/${fetcher.data.nextHandle}`, { replace: true });
      }
      return;
    }

    if (Array.isArray(fetcher.data.errors) && fetcher.data.errors.length > 0) {
      shopify.toast.show(fetcher.data.errors[0], { isError: true });
    }
  }, [data.tableHandle, fetcher.data, navigate, shopify]);

  useEffect(() => {
    const nextState = buildEditorState(data);
    setTitle(nextState.title);
    setSavedHeadingTitle(nextState.title);
    setStatus(nextState.status);
    setProducts(nextState.products);
    setTiers(nextState.tiers);
    resetMutationInput();
    setSavedTierCount(nextState.tiers.length);
    currentStateRef.current = cloneEditorState(nextState);
    committedStateRef.current = cloneEditorState(nextState);
    if (shopify?.saveBar?.hide) shopify.saveBar.hide();
  }, [data, shopify]);

  if (data.notFound) {
    return (
      <s-page heading="Discount rule" inlineSize="small">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" alignItems="center" gap="small-100">
            <s-button variant="secondary" icon="arrow-left" href={backHref} />
            <s-heading>{data.title}</s-heading>
          </s-stack>
          <s-section>
            <s-text>This rule was not found.</s-text>
          </s-section>
        </s-stack>
      </s-page>
    );
  }

  const serializedProducts = serializeProductIds(products);

  return (
    <s-page heading="Discount rule" inlineSize="small">
      <s-stack direction="block" gap="base">
        <form
          method="post"
          id="rule-settings-form"
          data-save-bar
          ref={ruleFormRef}
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            fetcher.submit(new FormData(form), { method: "post" });
          }}
          onReset={(event) => {
            event.preventDefault();
            restoreCommittedState();
          }}
        >
          <input type="hidden" name="_action" value="update-rule-settings" />
          <input
            ref={mutationInputRef}
            type="text"
            name="_mutationKey"
            defaultValue="0"
            tabIndex={-1}
            aria-hidden="true"
            autoComplete="off"
            style={{
              position: "absolute",
              opacity: 0,
              pointerEvents: "none",
              inlineSize: "1px",
              blockSize: "1px",
              inset: 0,
            }}
          />
          <input ref={tiersInputRef} type="hidden" name="tiers" value={JSON.stringify(tiers)} />
          <input ref={productsInputRef} type="hidden" name="products" value={serializedProducts} />

          <s-stack direction="block" gap="base">
            <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="small-100">
              <s-stack direction="inline" alignItems="center" gap="small-100">
                <s-button type="button" variant="secondary" icon="arrow-left" href={backHref} />
                <s-heading>{savedHeadingTitle}</s-heading>
              </s-stack>
              <s-button type="button" variant="secondary" tone="critical" onClick={handleDeleteRule}>
                {savedTierCount > 1 ? "Delete discounts" : "Delete discount"}
              </s-button>
            </s-stack>

            <s-section>
              <s-stack direction="block" gap="base">
                <s-text-field
                  label="Title"
                  name="title"
                  value={title}
                  onInput={(event) => {
                    setTitle(event.currentTarget?.value ?? "");
                  }}
                />
                <s-select
                  label="Status"
                  name="status"
                  value={status}
                  onChange={(event) => {
                    setStatus(event.currentTarget.value);
                  }}
                >
                  <s-option value="active">Active</s-option>
                  <s-option value="inactive">Inactive</s-option>
                </s-select>
              </s-stack>
            </s-section>

            <s-section>
              <s-stack direction="block" gap="base">
                <s-heading>Discount tiers</s-heading>
                <s-stack direction="block" gap="small-200">
                  {Array.isArray(tiers) && tiers.length > 0 ? (
                    tiers.map((tier, index) => {
                      return (
                        <s-stack key={`tier-${index}`} direction="inline" gap="base" alignItems="end">
                          <div style={{ flex: 1 }}>
                            <s-text-field
                              label="Title"
                              value={tier?.title ?? ""}
                              onInput={(event) => {
                                updateTierField(index, "title", event.currentTarget?.value ?? "");
                              }}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <s-text-field
                              type="number"
                              label="Minimum Product Quantity"
                              value={tier?.min_quantity ?? ""}
                              onInput={(event) => {
                                updateTierField(index, "min_quantity", event.currentTarget?.value ?? "");
                              }}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <s-text-field
                              type="number"
                              label="Percent off"
                              value={tier?.percent_off ?? ""}
                              onInput={(event) => {
                                updateTierField(index, "percent_off", event.currentTarget?.value ?? "");
                              }}
                            />
                          </div>
                          {tiers.length > 1 ? (
                            <s-button
                              type="button"
                              variant="secondary"
                              icon="delete"
                              accessibilityLabel="Delete tier"
                              onClick={() => handleRemoveTier(index)}
                            />
                          ) : null}
                        </s-stack>
                      );
                    })
                  ) : (
                    <s-text>No discount tiers found for this rule.</s-text>
                  )}
                </s-stack>
                <s-button type="button" variant="primary" onClick={handleAddTier}>
                  Add tier
                </s-button>
              </s-stack>
            </s-section>

            <s-section>
              <s-stack direction="block" gap="base">
                <s-heading>Applies to products</s-heading>
                <s-stack direction="block" gap="small-200">
                  {products.length > 0 ? (
                    products.map((product) => (
                      <s-stack
                        key={product.id}
                        direction="inline"
                        alignItems="center"
                        justifyContent="space-between"
                        gap="small-400"
                      >
                        <s-stack direction="inline" alignItems="center" gap="base">
                          <s-box inlineSize="32px" blockSize="32px">
                            {product.image ? (
                              <s-image
                                src={product.image}
                                alt={product.title || "Product image"}
                                loading="lazy"
                                aspect-ratio="1/1"
                                objectFit="contain"
                                borderColor="strong"
                                borderStyle="solid"
                                borderWidth="small"
                                borderRadius="base"
                              />
                            ) : (
                              <s-box
                                inlineSize="32px"
                                blockSize="32px"
                                borderColor="strong"
                                borderStyle="solid"
                                borderWidth="small"
                                borderRadius="base"
                              />
                            )}
                          </s-box>
                          <s-paragraph>{product.title || product.id}</s-paragraph>
                        </s-stack>
                        {products.length > 1 ? (
                          <s-button
                            type="button"
                            variant="secondary"
                            icon="delete"
                            accessibilityLabel={`Remove ${product.title || "product"}`}
                            onClick={() => handleRemoveProduct(product.id)}
                          />
                        ) : null}
                      </s-stack>
                    ))
                  ) : (
                    <s-paragraph>No products are attached to this rule.</s-paragraph>
                  )}
                </s-stack>
                <s-button type="button" variant="primary" onClick={handleAddProducts}>
                  Add product
                </s-button>
              </s-stack>
            </s-section>
          </s-stack>
        </form>
      </s-stack>
    </s-page>
  );
}
