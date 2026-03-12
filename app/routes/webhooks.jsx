import { authenticate } from "../shopify.server"

export const action = async ({ request }) => {
  try {
    const { shop, topic } = await authenticate.webhook(request)

    console.log(`Verified ${topic} webhook from ${shop}`)

    switch (topic) {
      case "customers/data_request":
        console.log("Handling customer data request")
        break
      case "customers/redact":
        console.log("Handling customer redact request")
        break
      case "shop/redact":
        console.log("Handling shop redact request")
        break
      default:
        console.log("Unhandled compliance webhook topic:", topic)
    }

    return new Response("OK", { status: 200 })
  } catch (error) {
    console.error("Webhook verification failed:", error)
    return new Response("Unauthorized", { status: 401 })
  }
}