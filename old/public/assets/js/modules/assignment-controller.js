const providers = [];
const queue = [];
let isProcessing = false;
let lastSharedState = null;

function normalizeRequest(input) {
  if (input && typeof input === "object") {
    const { reason = "manual", ...rest } = input;
    return { reason, ...rest };
  }
  if (typeof input === "string" && input.trim() !== "") {
    return { reason: input.trim() };
  }
  return { reason: "manual" };
}

function sortProviders() {
  providers.sort((a, b) => {
    if (a.priority === b.priority) {
      return a.name.localeCompare(b.name);
    }
    return a.priority - b.priority;
  });
}

function registerProvider(name, runner, options = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("Provider name must be a non-empty string");
  }
  if (typeof runner !== "function") {
    throw new TypeError("Provider runner must be a function");
  }
  const normalizedName = name.trim();
  const priority = Number.isFinite(options.priority)
    ? Number(options.priority)
    : 0;
  const existingIndex = providers.findIndex(
    (provider) => provider.name === normalizedName,
  );
  const descriptor = { name: normalizedName, runner, priority };
  if (existingIndex >= 0) {
    providers.splice(existingIndex, 1, descriptor);
  } else {
    providers.push(descriptor);
  }
  sortProviders();
}

function buildContext(request) {
  const shared = {};
  return {
    request,
    shared,
    get scheduleData() {
      return typeof scheduleData !== "undefined" ? scheduleData : null;
    },
    get scheduleMap() {
      return typeof scheduleMap !== "undefined" ? scheduleMap : null;
    },
    get currentStoreId() {
      return typeof currentStoreId !== "undefined" ? currentStoreId : null;
    },
    get employeeList() {
      return typeof employeeList !== "undefined" ? employeeList : [];
    },
    get dateKey() {
      return typeof getCurrentDateKey === "function"
        ? getCurrentDateKey()
        : null;
    },
    markDirty(key) {
      if (!key) return;
      if (!shared.dirtyKeys) {
        shared.dirtyKeys = new Set();
      }
      shared.dirtyKeys.add(key);
    },
  };
}

async function runProviders(request) {
  const context = buildContext(request);
  for (const provider of providers) {
    // eslint-disable-next-line no-await-in-loop
    await provider.runner(context, context.shared);
  }
  lastSharedState = context.shared;
  return context.shared;
}

async function processQueue() {
  if (isProcessing) {
    return;
  }
  if (queue.length === 0) {
    return;
  }
  isProcessing = true;
  const { request, resolve, reject } = queue.shift();
  try {
    const result = await runProviders(request);
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    isProcessing = false;
    if (queue.length > 0) {
      processQueue();
    }
  }
}

function refresh(request = {}) {
  const normalized = normalizeRequest(request);
  return new Promise((resolve, reject) => {
    queue.push({ request: normalized, resolve, reject });
    processQueue();
  });
}

function getLastSharedState() {
  return lastSharedState;
}

const assignmentController = {
  registerProvider,
  refresh,
  getLastSharedState,
};

if (typeof window !== "undefined") {
  window.scheduleAssignmentController = assignmentController;
}

export default assignmentController;
