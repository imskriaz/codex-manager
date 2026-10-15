import { useState } from "preact/hooks";

export const XOOM_DONATION_URL =
  "https://www.xoom.com/en-us/usd/send-money/transfer?countryCode=BD&destinationCurrencyCode=BDT";
const BKASH_NUMBER = "01628301525";

export function buildXoomDonationUrl(amount: string): string {
  const url = new URL(XOOM_DONATION_URL);
  const value = Number(amount);
  if (Number.isFinite(value) && value > 0) url.searchParams.set("sendAmount", value.toFixed(2));
  return url.toString();
}

export function DonationDetails(props: { onOpenExternal: (url: string) => void }) {
  const [amount, setAmount] = useState("5");

  return (
    <div class="donation-details">
      <div class="donation-amount-row">
        <label>
          <span>Donation amount (USD)</span>
          <input
            type="number"
            min="1"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onInput={(event) => setAmount(event.currentTarget.value)}
          />
        </label>
        <button
          class="modal-primary-btn"
          type="button"
          disabled={!Number.isFinite(Number(amount)) || Number(amount) <= 0}
          onClick={() => props.onOpenExternal(buildXoomDonationUrl(amount))}
        >
          Open Xoom
        </button>
      </div>
      <div class="onboarding-donation-card">
        <div>
          <span>How to send</span>
          <strong>Use your PayPal account to sign in to Xoom, choose Bangladesh and BDT, then review and send.</strong>
        </div>
        <div>
          <span>Mobile wallet</span>
          <strong>Select Mobile Wallet → bKash, then enter Codex Manager · {BKASH_NUMBER}.</strong>
        </div>
      </div>
    </div>
  );
}
