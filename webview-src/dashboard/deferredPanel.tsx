import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

/** Shared loading never delays other panels or sends an action on retry. */
export function deferredPanel<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, name: string): ComponentType<P> {
  let loaded: ComponentType<P> | undefined, pending: Promise<ComponentType<P>> | undefined;
  const resolve = (): Promise<ComponentType<P>> => {
    if (loaded) return Promise.resolve(loaded);
    if (pending) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.race([
      Promise.resolve().then(load).then(module => {
        if (typeof module.default !== "function") throw new Error(`The ${name} module is incomplete.`);
        return module.default;
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Loading the ${name} timed out. Reconnect and retry.`)), 12_000); })
    ]).then(component => { loaded = component; return component; }).finally(() => { clearTimeout(timer); if (pending === work) pending = undefined; });
    pending = work;
    return work;
  };
  return function DeferredPanel(props: P) {
    const [component, setComponent] = useState<ComponentType<P> | undefined>(() => loaded);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      let active = true;
      void resolve().then(value => { if (active) setComponent(() => value); }, () => {
        if (active) setError(`The ${name} could not load. Reconnect and retry, or reload this dashboard after an extension update. Your other actions remain available.`);
      });
      return () => { active = false; };
    }, [attempt]);
    const Panel = component;
    return Panel ? <Panel {...props} /> : <div class="cli-context-empty" role={error ? "alert" : "status"} aria-busy={!error}>
      <span>{error || `Loading ${name}…`}</span>
      {error ? <button type="button" onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry {name}</button> : null}
    </div>;
  };
}
