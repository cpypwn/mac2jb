const coreApi = globalThis.__CIVSWITCH_CORE_API__;
if (!coreApi) throw new Error("tools/bundle.mjs did not initialize the core runtime API");

let logPolicy = null;

export function setLogPolicy(policy) {
  if (policy !== null && typeof policy !== "function")
    throw new TypeError("log policy must be a function or null");
  const previous = logPolicy;
  logPolicy = policy;
  return previous;
}

// Payload modules can temporarily filter runtime.log without changing the
// shared logger's default pass-through behavior.
async function policyLog(...args) {
  if (logPolicy) {
    const message = logPolicy(args[0]);
    if (message == null) return;
    args[0] = message;
  }
  return Reflect.apply(coreApi.log, coreApi, args);
}

const runtime = new Proxy(coreApi, {
  get(target, property, receiver) {
    if (property === "log") return policyLog;
    return Reflect.get(target, property, receiver);
  }
});

export default runtime;
export const waitMs = runtime.waitMs;
