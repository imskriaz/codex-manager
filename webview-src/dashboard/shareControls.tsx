import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DashboardNotice } from '../../src/domain/dashboard/types';

export function ShareLinkField(props: { url: string; label: string; disabled?: boolean; onFeedback: (notice: DashboardNotice) => void }) {
  const [copied, setCopied] = useState(false);
  const currentUrl = useRef(props.url); currentUrl.current = props.url;
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => setCopied(false), [props.url]);
  const copy = async () => {
    const url = props.url; setCopied(false);
    try {
      await navigator.clipboard.writeText(url);
      if (!mounted.current || currentUrl.current !== url) return;
      setCopied(true);
      props.onFeedback({ level: 'info', message: 'Shared link copied.' });
    } catch { if (mounted.current && currentUrl.current === url) props.onFeedback({ level: 'error', message: 'Copy was blocked. Select the link and copy it manually.' }); }
  };
  return <label class="share-link-field"><span>{props.label}</span><div class="cli-share-link-row"><input readOnly aria-label={props.label} value={props.url} onFocus={event => event.currentTarget.select()} /><button type="button" disabled={props.disabled} onClick={() => void copy()} aria-label={copied ? 'Link copied' : 'Copy shared link'} title={copied ? 'Link copied' : 'Copy shared link'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">{copied ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/></>}</svg></button></div></label>;
}

export function ShareAccessReview(props: { description: string; label: string; busy: boolean; disabled?: boolean; onConfirm: () => Promise<boolean | undefined> }) {
  const [review, setReview] = useState(false);
  const reviewRef = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), wasReview = useRef(false);
  useLayoutEffect(() => {
    if (review) reviewRef.current?.querySelector('button')?.focus();
    else if (wasReview.current) trigger.current?.focus();
    wasReview.current = review;
  }, [review]);
  return <section class="share-access-management"><div><strong>Existing links</strong><p>{props.description}</p></div>{review ? <div ref={reviewRef} class="share-revoke-review" role="group" aria-label="Confirm link revocation"><p>People using these links will lose access. This cannot be undone.</p><div><button type="button" disabled={props.busy} onClick={() => setReview(false)}>Cancel</button><button type="button" class="share-danger-button" disabled={props.busy || props.disabled} onClick={() => void props.onConfirm().then(success => { if (success) setReview(false); })}>{props.busy ? 'Please wait…' : 'Revoke access'}</button></div></div> : <button ref={trigger} type="button" class="share-manage-button" disabled={props.busy || props.disabled} onClick={() => setReview(true)}>{props.label}</button>}</section>;
}
