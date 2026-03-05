// Global state
let currentDate = new Date();
if (typeof INITIAL_DATE === "string" && INITIAL_DATE) {
  const parts = INITIAL_DATE.split("-").map((part) => parseInt(part, 10));
  if (
    parts.length === 3 &&
    parts.every((value) => Number.isInteger(value) && !Number.isNaN(value))
  ) {
    const candidate = new Date(parts[0], parts[1] - 1, parts[2]);
    if (!Number.isNaN(candidate.getTime())) {
      currentDate = candidate;
    }
  }
}
let currentStoreId = CURRENT_STORE_ID;
let editingEmployeeIndex = null;
let editingTaskEmployeeIndex = null;
let activeEmployeeDropdown = null;
let draggedElement = null;

// Employee data loaded from the server
let employeeList = [];

function apiUrl(path) {
  return `api/${path}?token=${encodeURIComponent(API_TOKEN)}&company_id=${COMPANY_ID}&store_id=${currentStoreId}`;
}

// Load employees from API
function loadEmployees() {
  if (currentStoreId <= 0) {
    employeeList = [];
    return Promise.resolve();
  }
  return fetch(apiUrl("staff.php") + "&admins=false")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((data) => {
      employeeList = Array.isArray(data) ? data : [];
    })
    .catch(() => {
      employeeList = [];
    });
}

// Save employees to API
function saveEmployees() {
  if (currentStoreId <= 0) return;
  fetch(apiUrl("staff.php"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(employeeList),
  }).catch(() => {
    showToast("error", "Failed to save employees");
  });
}

// Schedule data loaded from the server (keyed by date)
let scheduleMap = {};
let scheduleData = { employees: [] };

const STATE_BREAK_TYPE_CONFIG = [
  { type: "break1", durationField: "break1Duration" },
  { type: "lunch", durationField: "lunchDuration" },
  { type: "break2", durationField: "break2Duration" },
];

function coerceStateBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return !Number.isNaN(value) && value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", ""].includes(normalized)) {
      return false;
    }
  }
  return false;
}

function findStateBreakEntry(breaks, index, type) {
  if (!Array.isArray(breaks)) {
    return null;
  }
  for (let i = 0; i < breaks.length; i += 1) {
    const candidate = breaks[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const candidateType =
      candidate.type || STATE_BREAK_TYPE_CONFIG[i]?.type || null;
    if (candidateType === type) {
      return candidate;
    }
  }
  const fallback = breaks[index];
  return fallback && typeof fallback === "object" ? fallback : null;
}

function normalizeEmployeeBreakState(employee) {
  if (!employee || typeof employee !== "object") {
    return employee;
  }
  const rawBreaks = Array.isArray(employee.breaks) ? employee.breaks : [];
  const normalizedBreaks = [];
  STATE_BREAK_TYPE_CONFIG.forEach((config, idx) => {
    const entry = findStateBreakEntry(rawBreaks, idx, config.type) || {};
    const suffix = config.type.charAt(0).toUpperCase() + config.type.slice(1);
    const skipped =
      coerceStateBoolean(entry.skip) ||
      coerceStateBoolean(entry.skipped) ||
      coerceStateBoolean(employee[`${config.type}Skipped`]) ||
      coerceStateBoolean(employee[`${config.type}Skip`]) ||
      coerceStateBoolean(employee[`skip${suffix}`]);
    const start = skipped
      ? ""
      : entry.start || employee[config.type] || "";
    let durationValue = skipped
      ? ""
      : entry.duration ?? employee[config.durationField] ?? "";
    if (typeof durationValue === "number") {
      durationValue = Number.isFinite(durationValue)
        ? String(durationValue)
        : "";
    } else if (typeof durationValue === "string") {
      durationValue = durationValue.trim();
    } else {
      durationValue = "";
    }
    employee[config.type] = start;
    employee[config.durationField] = durationValue;
    employee[`${config.type}Skipped`] = skipped;

    if (skipped) {
      normalizedBreaks.push({ type: config.type, skip: true });
      return;
    }

    let storedDuration = entry.duration;
    if (storedDuration === undefined || storedDuration === null) {
      const parsed = parseInt(durationValue, 10);
      storedDuration = Number.isNaN(parsed) ? durationValue : parsed;
    }
    normalizedBreaks.push({
      type: config.type,
      start,
      duration: storedDuration,
    });
  });
  employee.breaks = normalizedBreaks;
  return employee;
}

// Helper to get YYYY-MM-DD key for the current date
function getCurrentDateKey() {
  return currentDate.toISOString().slice(0, 10);
}

// Switch scheduleData to the current date
function switchToCurrentDate() {
  const key = getCurrentDateKey();
  scheduleData = scheduleMap[key] || { employees: [] };
  scheduleMap[key] = scheduleData;
}

// Load schedule from API
function loadSchedule() {
  if (currentStoreId <= 0) {
    scheduleMap = {};
    switchToCurrentDate();
    return Promise.resolve();
  }
  return fetch(apiUrl("schedule.php"))
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((data) => {
      if (data && Array.isArray(data.employees)) {
        const key = getCurrentDateKey();
        scheduleMap = { [key]: { employees: data.employees } };
      } else if (data && !Array.isArray(data) && typeof data === "object") {
        scheduleMap = data;
      } else {
        scheduleMap = {};
      }
      Object.values(scheduleMap).forEach((day) => {
        if (Array.isArray(day.employees)) {
          day.employees = day.employees.map((emp) => {
            if (emp && typeof emp === "object") {
              normalizeEmployeeBreakState(emp);
            }
            return emp;
          });
        }
      });
      switchToCurrentDate();
    })
    .catch(() => {
      scheduleMap = {};
      switchToCurrentDate();
    });
}

// Save schedule to API
function saveSchedule() {
  if (currentStoreId <= 0) return;
  const key = getCurrentDateKey();
  scheduleMap[key] = scheduleData;
  fetch(apiUrl("schedule.php"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scheduleMap),
  }).catch(() => {
    showToast("error", "Failed to save schedule");
  });
}

// General tasks loaded from the server
let generalTasks = [];
let choreTemplateLibrary = [];
let choreSaveTimeout = null;
let choreSaveController = null;
let choreSavePromise = Promise.resolve();

function cloneChoreTemplate(chore) {
  if (!chore || typeof chore !== "object") {
    return {};
  }
  try {
    return structuredClone(chore);
  } catch (error) {
    return JSON.parse(JSON.stringify(chore));
  }
}

function normalizeShowOnDays(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map((day) => {
        const parsed = parseInt(day, 10);
        return Number.isNaN(parsed) ? null : parsed;
      })
      .filter((day) => day !== null);
    return normalized.length === 0 ? null : normalized;
  }
  return null;
}

function normalizeChoreRecord(record) {
  const base = record && typeof record === "object" ? { ...record } : {};
  base.assignedTo = base.assignedTo ?? null;
  base.showOnDays = normalizeShowOnDays(base.showOnDays ?? base.activeDays);
  return base;
}

// Load chores from API
function loadChores() {
  return fetch(apiUrl("chores.php"))
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((data) => {
      generalTasks = Array.isArray(data)
        ? data.map((t) => normalizeChoreRecord(t))
        : [];
      choreTemplateLibrary = generalTasks.map((task) =>
        cloneChoreTemplate(task),
      );
      window.choreTemplateLibrary = choreTemplateLibrary;
      window.generalTasks = generalTasks;
      if (typeof renderGeneralTasks === "function") {
        renderGeneralTasks();
      }
      if (typeof renderChoreList === "function") {
        renderChoreList();
      }
    })
    .catch(() => {
      generalTasks = [];
      choreTemplateLibrary = [];
      window.choreTemplateLibrary = choreTemplateLibrary;
      window.generalTasks = generalTasks;
      if (typeof renderGeneralTasks === "function") {
        renderGeneralTasks();
      }
      if (typeof renderChoreList === "function") {
        renderChoreList();
      }
    });
}

// Save chores to API
function saveChores() {
  if (currentStoreId <= 0) return Promise.resolve();
  const payload = JSON.stringify(generalTasks);
  clearTimeout(choreSaveTimeout);
  choreSaveTimeout = setTimeout(() => {
    choreSaveController?.abort();
    choreSaveController = new AbortController();
    choreSavePromise = fetch(apiUrl("chores.php"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: choreSaveController.signal,
    }).catch(() => {});
  }, 100);
  return choreSavePromise;
}

async function refreshChoreAssignments() {
  if (!Array.isArray(scheduleData.employees)) {
    return;
  }

  if (scheduleData.employees.length === 0) {
    scheduleData.employees = [];
    return;
  }

  const dateKey = getCurrentDateKey();
  const employeesPayload = scheduleData.employees.map((employee, index) => {
    const breaks = Array.isArray(employee.breaks) ? employee.breaks : [];
    const tasks = Array.isArray(employee.tasks) ? employee.tasks : [];
      const clone = {
        index,
        id: employee.id ?? null,
        name: employee.name ?? "",
        pos: employee.pos ?? "",
        shift: employee.shift ?? "",
        breaks,
        tasks,
        metadata: employee.metadata ?? employee.meta ?? null,
        break1: employee.break1 ?? "",
        break1Duration: employee.break1Duration ?? "",
        break1Skipped: coerceStateBoolean(employee.break1Skipped),
        lunch: employee.lunch ?? "",
        lunchDuration: employee.lunchDuration ?? "",
        lunchSkipped: coerceStateBoolean(employee.lunchSkipped),
        break2: employee.break2 ?? "",
        break2Duration: employee.break2Duration ?? "",
        break2Skipped: coerceStateBoolean(employee.break2Skipped),
        signOff: employee.signOff ?? "",
      };
    return clone;
  });

  try {
    const response = await fetch(apiUrl("chore_assignments.php"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: dateKey, employees: employeesPayload }),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch assignments");
    }
    const data = await response.json();
    const assignments = Array.isArray(data?.employees) ? data.employees : [];
    scheduleData.employees.forEach((emp) => {
      emp.tasks = [];
    });
    assignments.forEach((assignment) => {
      const idx = Number.isInteger(assignment.index)
        ? assignment.index
        : null;
      if (idx === null || !scheduleData.employees[idx]) {
        return;
      }
      const target = scheduleData.employees[idx];
      const incomingTasks = Array.isArray(assignment.tasks)
        ? assignment.tasks
        : [];
      target.tasks = incomingTasks
        .map((task) => {
          if (typeof task === "string") {
            return { description: task, type: "chore" };
          }
          if (task && typeof task === "object") {
            const description = String(task.description ?? "").trim();
            if (description === "") {
              return null;
            }
            const type =
              typeof task.type === "string" && task.type.trim() !== ""
                ? task.type
                : "chore";
            return { description, type };
          }
          return null;
        })
        .filter(Boolean);
    });
  } catch (error) {
    scheduleData.employees.forEach((emp) => {
      if (!Array.isArray(emp.tasks)) {
        emp.tasks = [];
      }
    });
  }
}

// DOM Elements
const currentDateDisplay = document.getElementById("currentDateDisplay");
const printDateDisplay = document.getElementById("printDateDisplay");
const scheduleBody = document.getElementById("scheduleBody");
const generalTasksContainer = document.getElementById("generalTasksContainer");
const employeeSelector = document.getElementById("employeeSelector");
const totalEmployees = document.getElementById("totalEmployees");
const morningShift = document.getElementById("morningShift");
const afternoonShift = document.getElementById("afternoonShift");
const totalHours = document.getElementById("totalHours");
const toast = document.getElementById("toast");
const toastIcon = document.getElementById("toastIcon");
const toastMessage = document.getElementById("toastMessage");
const employeeNameDropdown = document.getElementById("employeeNameDropdown");
let recyclingTask = document.getElementById("recyclingTask");
const breakTimelineContainer = document.getElementById(
  "breakTimelineContainer",
);

function getChoreOptionsSnapshot() {
  return generalTasks.map((task) => ({
    id: task.id,
    description: task.description ?? "",
  }));
}

window.getChoreOptions = getChoreOptionsSnapshot;

function getChoreTemplatesSnapshot() {
  return choreTemplateLibrary.map((task) => cloneChoreTemplate(task));
}

function registerChoreTemplate(template) {
  if (!template || typeof template !== "object") {
    return;
  }
  choreTemplateLibrary.push(cloneChoreTemplate(template));
}

window.getChoreTemplates = getChoreTemplatesSnapshot;
window.registerChoreTemplate = registerChoreTemplate;
window.refreshChoreAssignments = refreshChoreAssignments;
