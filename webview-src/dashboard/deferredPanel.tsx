import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

/** Shared loading never delays other panels or sends an action on retry. */
export function deferredPanel<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, name: string,enabled:(props:P)=>boolean=()=>true): ComponentType<P> {
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
    const loadEnabled=enabled(props);
    const [component, setComponent] = useState<ComponentType<P> | undefined>(() => loaded);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if(!loadEnabled)return;
      let active = true;
      void resolve().then(value => { if (active) setComponent(() => value); }, reason => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason || `The ${name} module could not be loaded.`));
      });
      return () => { active = false; };
    }, [attempt,loadEnabled]);
    const Panel = component;
    if(!Panel&&!loadEnabled)return null;
    return Panel ? <Panel {...props} /> : <div class="cli-context-empty cli-deferred-panel" role={error ? "alert" : "status"} aria-busy={!error}>
      {error ? <>
        <strong>Could not load {name}</strong>
        <span>{error}</span>
        <span>Retry loading, or reload the dashboard after an extension update. Your other actions remain available.</span>
        <div class="cli-deferred-panel-actions">
          <button type="button" onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry {name}</button>
          <button type="button" onClick={() => window.location.reload()}>Reload dashboard</button>
        </div>
      </> : <span>{`Loading ${name}…`}</span>}
    </div>;
  };
}
