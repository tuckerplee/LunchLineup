const originalFetch = window.fetch;
let refreshPromise = null;
let sessionExpiryTimer = null;
let hasNotifiedSessionExpiry = false;
let sessionMonitorInitialized = false;

const SESSION_EXPIRY_BUFFER_MS = 30000;
const SESSION_FALLBACK_MS = 5 * 60 * 1000;

function getCurrentToken() {
  if (typeof API_TOKEN !== "undefined" && API_TOKEN) {
    return API_TOKEN;
  }
  if (typeof window !== "undefined" && typeof window.API_TOKEN !== "undefined") {
    return window.API_TOKEN;
  }
  return null;
}

function setCurrentToken(token) {
  if (!token) return;
  if (typeof API_TOKEN !== "undefined") {
    API_TOKEN = token;
  } else if (typeof window !== "undefined") {
    window.API_TOKEN = token;
  }
  scheduleSessionExpiryCheck(token);
}

function base64UrlDecodeSegment(segment) {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
    const padded = normalized + "=".repeat(padding);
    return atob(padded);
  } catch (error) {
    return null;
  }
}

function getTokenExpiryMs(token) {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payloadJson = base64UrlDecodeSegment(parts[1]);
  if (!payloadJson) {
    return null;
  }
  try {
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload.exp !== "number") {
      return null;
    }
    return payload.exp * 1000;
  } catch (error) {
    return null;
  }
}

function scheduleSessionExpiryCheck(token) {
  if (sessionExpiryTimer) {
    clearTimeout(sessionExpiryTimer);
    sessionExpiryTimer = null;
  }
  if (!token) {
    return;
  }
  const expiryMs = getTokenExpiryMs(token);
  if (expiryMs === null) {
    sessionExpiryTimer = window.setTimeout(checkSessionExpiration, SESSION_FALLBACK_MS);
    return;
  }
  const now = Date.now();
  const delay = Math.max(expiryMs - now - SESSION_EXPIRY_BUFFER_MS, 0);
  sessionExpiryTimer = window.setTimeout(checkSessionExpiration, delay);
}

function getRedirectUrl() {
  const path = window.location.pathname;
  const slashIndex = path.lastIndexOf("/");
  const basePath = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "/";
  return `${basePath}index.php`;
}

function handleSessionExpired() {
  if (hasNotifiedSessionExpiry) {
    return;
  }
  hasNotifiedSessionExpiry = true;
  if (sessionExpiryTimer) {
    clearTimeout(sessionExpiryTimer);
    sessionExpiryTimer = null;
  }
  const message = "Your session has expired. Redirecting to the login page...";
  if (
    typeof showToast === "function" &&
    typeof toast !== "undefined" &&
    toast &&
    typeof hideToast === "function"
  ) {
    showToast("error", message);
  } else {
    window.alert(message);
  }
  window.setTimeout(() => {
    window.location.replace(getRedirectUrl());
  }, 1500);
}

function checkSessionExpiration() {
  if (hasNotifiedSessionExpiry) {
    return;
  }
  const token = getCurrentToken();
  if (!token) {
    return;
  }
  const expiryMs = getTokenExpiryMs(token);
  if (expiryMs !== null && expiryMs <= Date.now()) {
    handleSessionExpired();
    return;
  }
  scheduleSessionExpiryCheck(token);
}

async function refreshAuthToken() {
  if (refreshPromise) {
    return refreshPromise;
  }
  refreshPromise = (async () => {
    try {
      const refreshResponse = await originalFetch("/api/auth.php");
      if (!refreshResponse.ok) {
        return false;
      }
      const data = await refreshResponse.json().catch(() => null);
      if (data && typeof data.token === "string" && data.token) {
        setCurrentToken(data.token);
        return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  })();
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function prepareRequestWithToken(input, init) {
  let newInput = input;
  let newInit = init ? { ...init } : init;
  const token = getCurrentToken();
  if (typeof input === "string") {
    try {
      const url = new URL(input, window.location.origin);
      if (token && url.searchParams.has("token")) {
        url.searchParams.set("token", token);
        newInput = url.toString();
      }
    } catch (error) {
      // ignore malformed URLs
    }
  }
  if (newInit && newInit.body) {
    if (newInit.body instanceof URLSearchParams) {
      const params = new URLSearchParams(newInit.body.toString());
      if (token && params.has("token")) {
        params.set("token", token);
      }
      newInit.body = params;
    } else if (typeof newInit.body === "string" && newInit.body.includes("token=")) {
      const params = new URLSearchParams(newInit.body);
      if (token && params.has("token")) {
        params.set("token", token);
      }
      newInit.body = params.toString();
    }
  }
  return [newInput, newInit];
}

async function extractErrorMessage(response) {
  try {
    const jsonClone = response.clone();
    const contentType = jsonClone.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await jsonClone.json();
      if (data && typeof data.message === "string") {
        return data.message;
      }
      if (data && typeof data.error === "string") {
        return data.error;
      }
    }
  } catch (error) {
    // ignore JSON parse failures
  }
  try {
    return await response.clone().text();
  } catch (error) {
    return "";
  }
}

async function handleUnauthorizedResponse(response) {
  const message = await extractErrorMessage(response);
  if (message && /invalid token/i.test(message)) {
    handleSessionExpired();
  }
}

window.fetch = async function (input, init) {
  let response = await originalFetch(input, init);
  if (response.status === 401 || response.status === 403) {
    const refreshed = await refreshAuthToken();
    if (refreshed) {
      const [retryInput, retryInit] = prepareRequestWithToken(input, init);
      response = await originalFetch(retryInput, retryInit);
    }
    if (response.status === 401 || response.status === 403) {
      await handleUnauthorizedResponse(response);
    }
  }
  return response;
};

function initializeSessionMonitor() {
  if (sessionMonitorInitialized) {
    return;
  }
  sessionMonitorInitialized = true;
  window.addEventListener("focus", checkSessionExpiration);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      checkSessionExpiration();
    }
  });
  const token = getCurrentToken();
  if (token) {
    scheduleSessionExpiryCheck(token);
    checkSessionExpiration();
  }
}

initializeSessionMonitor();

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Show toast notification
function showToast(type, message) {
  toast.className = "toast";
  toast.classList.add(`toast-${type}`);

  // Set icon based on type
  if (type === "success") {
    toastIcon.textContent = "✓";
  } else if (type === "error") {
    toastIcon.textContent = "✗";
  } else {
    toastIcon.textContent = "ℹ";
  }

  toastMessage.textContent = message;

  // Show toast
  setTimeout(() => {
    toast.classList.add("show");
  }, 100);

  // Auto hide after 3 seconds
  setTimeout(hideToast, 3000);
}

// Hide toast notification
function hideToast() {
  toast.classList.remove("show");
}

// Parse a YYYY-MM-DD date string as a local Date object
function parseDateKey(dateStr) {
  const parts = dateStr.split("-");
  return new Date(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[2], 10),
  );
}

// Format date for display (Month DD, YYYY)
function formatDateForDisplay(date) {
  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  return date.toLocaleDateString("en-US", options);
}

// Update URL query parameter to persist the current date
function updateDateQueryParam() {
  if (
    typeof window === "undefined" ||
    typeof URL === "undefined" ||
    !(currentDate instanceof Date) ||
    Number.isNaN(currentDate.getTime()) ||
    !window.history ||
    typeof window.history.replaceState !== "function"
  ) {
    return;
  }

  try {
    const url = new URL(window.location.href);
    url.searchParams.set("date", getCurrentDateKey());
    const newUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, "", newUrl);
  } catch (error) {
    // Ignore URL parsing errors and leave the current URL intact
  }
}

// Update date display
function updateDateDisplay() {
  const formattedDate = formatDateForDisplay(currentDate);
  if (typeof datePicker !== "undefined" && datePicker) {
    datePicker.setDate(currentDate, false);
  }
  if (currentDateDisplay instanceof HTMLInputElement) {
    currentDateDisplay.value = formattedDate;
  } else {
    currentDateDisplay.textContent = formattedDate;
  }
  printDateDisplay.textContent = formattedDate;
  updateDateQueryParam();
  notifyIfNotToday();
}

// Show a toast if the selected date is not today
function notifyIfNotToday() {
  const today = new Date();
  if (
    currentDate.getFullYear() !== today.getFullYear() ||
    currentDate.getMonth() !== today.getMonth() ||
    currentDate.getDate() !== today.getDate()
  ) {
    showToast(
      "info",
      `Viewing schedule for ${formatDateForDisplay(currentDate)} (not today)`,
    );
  }
}

// Update recycling task visibility based on day of week
function updateRecyclingTaskVisibility() {
  const taskEl = document.getElementById("recyclingTask");
  if (!taskEl) return;

  const dayOfWeek = currentDate.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Check if today is Wednesday (3) or Sunday (0)
  if (dayOfWeek === 3 || dayOfWeek === 0) {
    taskEl.style.display = "flex";
  } else {
    taskEl.style.display = "none";
  }
}

// Parse time string to hours (decimal)
function parseTimeString(timeStr) {
  // Extract hours and minutes
  let hours = 0;
  let minutes = 0;

  // Check if time is in 12-hour format with AM/PM
  const isPM = timeStr.toLowerCase().includes("pm");
  const isAM = timeStr.toLowerCase().includes("am");

  // Remove AM/PM and trim
  timeStr = timeStr.replace(/am|pm/i, "").trim();

  if (timeStr.includes(":")) {
    const parts = timeStr.split(":");
    hours = parseInt(parts[0], 10);
    minutes = parseInt(parts[1], 10);
  } else {
    hours = parseInt(timeStr, 10);
  }

  // Convert to 24-hour format if needed
  if (isPM && hours < 12) {
    hours += 12;
  } else if (isAM && hours === 12) {
    hours = 0;
  }

  return hours + minutes / 60;
}

// Format time for display (12-hour format with AM/PM)
function formatTimeForDisplay(hours, minutes) {
  let period = "AM";
  let displayHours = hours;

  if (hours >= 12) {
    period = "PM";
    if (hours > 12) {
      displayHours = hours - 12;
    }
  }

  if (hours === 0) {
    displayHours = 12;
  }

  return `${displayHours}:${minutes.toString().padStart(2, "0")} ${period}`;
}

// Parse time string for input field (HH:MM format)
function parseTimeForInput(timeStr) {
  // Extract hours and minutes
  let hours = 0;
  let minutes = 0;

  // Check if time is in 12-hour format with AM/PM
  const isPM = timeStr.toLowerCase().includes("pm");
  const isAM = timeStr.toLowerCase().includes("am");

  // Remove AM/PM and trim
  timeStr = timeStr.replace(/am|pm/i, "").trim();

  if (timeStr.includes(":")) {
    const parts = timeStr.split(":");
    hours = parseInt(parts[0], 10);
    minutes = parseInt(parts[1], 10);
  } else {
    hours = parseInt(timeStr, 10);
  }

  // Convert to 24-hour format if needed
  if (isPM && hours < 12) {
    hours += 12;
  } else if (isAM && hours === 12) {
    hours = 0;
  }

  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

let lastKnownToday = new Date();

function isSameCalendarDay(dateA, dateB) {
  if (!(dateA instanceof Date) || Number.isNaN(dateA.getTime())) {
    return false;
  }
  if (!(dateB instanceof Date) || Number.isNaN(dateB.getTime())) {
    return false;
  }
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

// Check if the currentDate has rolled over to a new calendar day
async function checkForDateChange() {
  const today = new Date();
  if (isSameCalendarDay(today, lastKnownToday)) {
    return;
  }

  const wasViewingLastKnownToday = isSameCalendarDay(currentDate, lastKnownToday);
  lastKnownToday = today;

  if (!wasViewingLastKnownToday) {
    return;
  }

  currentDate = today;
  switchToCurrentDate();
  updateDateDisplay();
  updateRecyclingTaskVisibility();
  await refreshScheduleOutputs({ reason: "date:auto", skipSave: true });
}
