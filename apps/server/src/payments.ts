import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type CreateProviderOrderInput = {
  amountPaise: number;
  currency: "INR";
  receipt: string;
  notes: Record<string, string>;
};

export type ProviderOrder = { id: string; amountPaise: number; currency: "INR" };

export interface PaymentAdapter {
  readonly kind: "mock" | "razorpay";
  readonly publicKeyId: string;
  createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder>;
  verifyPayment(orderId: string, paymentId: string, signature: string): boolean;
}

export class MockPaymentAdapter implements PaymentAdapter {
  readonly kind = "mock" as const;
  readonly publicKeyId = "rzp_test_spendseal_mock";
  readonly secret: string;
  createOrderCalls = 0;
  failNextAsAmbiguous = false;

  constructor(secret = "agentrail_mock_secret") {
    this.secret = secret;
  }

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    this.createOrderCalls += 1;
    if (this.failNextAsAmbiguous) {
      this.failNextAsAmbiguous = false;
      throw new AmbiguousPaymentError("Provider timed out after accepting the request");
    }
    return { id: `order_mock_${randomUUID().replaceAll("-", "").slice(0, 18)}`, amountPaise: input.amountPaise, currency: "INR" };
  }

  sign(orderId: string, paymentId: string): string {
    return createHmac("sha256", this.secret).update(`${orderId}|${paymentId}`).digest("hex");
  }

  verifyPayment(orderId: string, paymentId: string, signature: string): boolean {
    return secureEqual(this.sign(orderId, paymentId), signature);
  }
}

export class RazorpayPaymentAdapter implements PaymentAdapter {
  readonly kind = "razorpay" as const;
  readonly publicKeyId: string;
  private readonly secret: string;

  constructor(keyId: string, keySecret: string) {
    this.publicKeyId = keyId;
    this.secret = keySecret;
  }

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    let response: Response;
    try {
      response = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.publicKeyId}:${this.secret}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amount: input.amountPaise,
          currency: input.currency,
          receipt: input.receipt.slice(0, 40),
          notes: input.notes,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new AmbiguousPaymentError(error instanceof Error ? error.message : "Razorpay request failed");
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new PaymentProviderError(`Razorpay rejected order creation (${response.status}): ${detail.slice(0, 300)}`);
    }
    const body = (await response.json()) as { id: string; amount: number; currency: string };
    return { id: body.id, amountPaise: body.amount, currency: "INR" };
  }

  async verifyConnection(): Promise<void> {
    let response: Response;
    try { response = await fetch("https://api.razorpay.com/v1/orders?count=1", { headers: { authorization: `Basic ${Buffer.from(`${this.publicKeyId}:${this.secret}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) }); }
    catch (error) { throw new PaymentProviderError(error instanceof Error ? error.message : "Razorpay credential check failed"); }
    if (!response.ok) throw new PaymentProviderError(`Razorpay Test credentials were rejected (${response.status}).`);
  }

  verifyPayment(orderId: string, paymentId: string, signature: string): boolean {
    const expected = createHmac("sha256", this.secret).update(`${orderId}|${paymentId}`).digest("hex");
    return secureEqual(expected, signature);
  }
}

export class PaymentProviderError extends Error {}
export class AmbiguousPaymentError extends PaymentProviderError {}

export function verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return secureEqual(expected, signature);
}

function secureEqual(expected: string, received: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
