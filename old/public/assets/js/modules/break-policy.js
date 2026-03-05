let defaultPolicy = null;

export function setBreakPolicy(policy) {
  scheduleMap.breakPolicy = policy;
  defaultPolicy = policy;
}

export function getBreakPolicy() {
  return scheduleMap.breakPolicy || defaultPolicy || {};
}
