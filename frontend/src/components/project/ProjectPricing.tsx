import TransparentReceipt from "../ui/TransparentReceipt";

interface ProjectPricingProps {
  pricingType: "free" | "pwyw" | "paid";
  price: string | null;
  minPrice: string | null;
  suggestedPrice: string | null;
}

function buildReceipt(price: number) {
  const processing = Math.round(price * 0.029 * 100) / 100 + 0.3; // Stripe ~2.9% + $0.30
  const crf = Math.round(price * 0.03 * 100) / 100; // 3% CRF
  const creatorTotal = Math.round((price - processing - crf) * 100) / 100;

  return {
    price,
    lines: [
      { label: "Payment processing", amount: processing, note: "Stripe" },
      { label: "Community Resilience Fund", amount: crf, note: "3%" },
    ],
    creatorTotal: Math.max(creatorTotal, 0),
  };
}

export default function ProjectPricing({
  pricingType,
  price,
  minPrice,
  suggestedPrice,
}: ProjectPricingProps) {
  if (pricingType === "free") return null;

  const displayPrice =
    pricingType === "paid"
      ? parseFloat(price || "0")
      : parseFloat(suggestedPrice || minPrice || "5");

  const receipt = buildReceipt(displayPrice);

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Pricing</h2>

      {pricingType === "paid" && (
        <p className="text-2xl font-bold mb-3">${parseFloat(price || "0").toFixed(2)}</p>
      )}

      {pricingType === "pwyw" && (
        <div className="mb-3">
          <p className="text-lg font-medium">Pay What You Want</p>
          {minPrice && parseFloat(minPrice) > 0 && (
            <p className="text-sm text-base-content/60">
              Minimum: ${parseFloat(minPrice).toFixed(2)}
            </p>
          )}
          {suggestedPrice && (
            <p className="text-sm text-base-content/60">
              Suggested: ${parseFloat(suggestedPrice).toFixed(2)}
            </p>
          )}
        </div>
      )}

      <TransparentReceipt {...receipt} />

      <div className="mt-3 p-3 bg-base-200 rounded-lg">
        <p className="text-sm text-base-content/60">
          Payments coming soon. When available, creators will keep 100% of
          earnings — only real infrastructure costs are passed through.
        </p>
      </div>
    </div>
  );
}
