import { useEffect, useRef, useState } from "preact/hooks";

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
  const [amount, setAmount] = useState("10.11");
  const [copyNotice, setCopyNotice] = useState<string>();
  const copyNoticeTimer = useRef<number>();

  useEffect(() => () => {
    if (copyNoticeTimer.current) window.clearTimeout(copyNoticeTimer.current);
  }, []);

  const showCopyNotice = (message: string) => {
    if (copyNoticeTimer.current) window.clearTimeout(copyNoticeTimer.current);
    setCopyNotice(message);
    copyNoticeTimer.current = window.setTimeout(() => {
      copyNoticeTimer.current = undefined;
      setCopyNotice(undefined);
    }, 2_500);
  };

  const openXoom = () => {
    props.onOpenExternal(buildXoomDonationUrl(amount));
    void Promise.resolve().then(() => navigator.clipboard.writeText(BKASH_NUMBER)).then(
      () => showCopyNotice(`Copied ${BKASH_NUMBER}`),
      () => showCopyNotice("Copy failed. Select the phone number and copy it manually.")
    );
  };

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
          onClick={openXoom}
        >
          Open Xoom
        </button>
      </div>
      {copyNotice ? <div class="donation-copy-toast" role="status" aria-live="polite">{copyNotice}</div> : null}
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
