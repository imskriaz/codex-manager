export function officeCapacityMessage(retryAt: number): string {
  const time = new Date(retryAt).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit', hour12: true});
  return `All assistants are busy. You're in the queue. We'll check again at ${time}.`;
}
