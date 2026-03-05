import { getBreakPolicy, setBreakPolicy } from "./break-policy.js";
import assignmentController from "./assignment-controller.js";

const templateSelector =
  typeof document !== "undefined"
    ? document.getElementById("templateSelector")
    : null;
let templateList = window.templateList || [];
window.templateList = templateList;

const BREAK_TYPE_CONFIG = [
  { type: "break1", durationField: "break1Duration" },
  { type: "lunch", durationField: "lunchDuration" },
  { type: "break2", durationField: "break2Duration" },
];

let activeDraggedChore = null;

function buildChoreAssignmentPayload(task) {
  if (!task || typeof task !== "object") {
    return null;
  }
  const description = getChoreDisplayName(task);
  if (description === "") {
    return null;
  }
  const type =
    typeof task.type === "string" && task.type.trim() !== ""
      ? task.type.trim()
      : "chore";
  const payload = {
    choreId:
      typeof task.id === "number" && Number.isFinite(task.id) ? task.id : null,
    description,
    label:
      typeof task.description === "string" && task.description.trim() !== ""
        ? task.description.trim()
        : description,
    type,
    autoAssigned: false,
    source: "manual-drag",
  };
  return payload;
}

function handleChoreDragStart(event, task) {
  const payload = buildChoreAssignmentPayload(task);
  if (!payload) {
    event.preventDefault();
    return;
  }
  if (event.currentTarget && event.currentTarget.setAttribute) {
    event.currentTarget.setAttribute("aria-grabbed", "true");
  }
  activeDraggedChore = payload;
  if (event.dataTransfer) {
    const serialized = JSON.stringify(payload);
    event.dataTransfer.effectAllowed = "copy";
    try {
      event.dataTransfer.setData("application/json", serialized);
    } catch (error) {}
    event.dataTransfer.setData("text/plain", serialized);
  }
  document.body.classList.add("chore-drag-active");
}

function handleChoreDragEnd(event) {
  if (event?.currentTarget && event.currentTarget.setAttribute) {
    event.currentTarget.setAttribute("aria-grabbed", "false");
  }
  activeDraggedChore = null;
  document.body.classList.remove("chore-drag-active");
  document
    .querySelectorAll(".task-cell--droppable")
    .forEach((cell) => cell.classList.remove("task-cell--droppable"));
}

function parseDraggedChore(event) {
  if (activeDraggedChore) {
    return activeDraggedChore;
  }
  if (!event?.dataTransfer) {
    return null;
  }
  let raw = "";
  try {
    raw = event.dataTransfer.getData("application/json");
  } catch (error) {
    raw = "";
  }
  if (!raw) {
    raw = event.dataTransfer.getData("text/plain");
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (error) {}
  return null;
}

function assignChoreToEmployee(employeeIndex, chorePayload) {
  if (
    !Number.isInteger(employeeIndex) ||
    !scheduleData.employees ||
    !scheduleData.employees[employeeIndex] ||
    !chorePayload
  ) {
    return false;
  }
  const employee = scheduleData.employees[employeeIndex];
  if (!Array.isArray(employee.tasks)) {
    employee.tasks = [];
  }
  if (
    chorePayload.choreId !== null &&
    employee.tasks.some(
      (existing) => existing && existing.choreId === chorePayload.choreId,
    )
  ) {
    return false;
  }
  const taskRecord = {
    description: chorePayload.description ?? "",
    label:
      typeof chorePayload.label === "string" &&
      chorePayload.label.trim() !== ""
        ? chorePayload.label
        : chorePayload.description ?? "",
    type:
      typeof chorePayload.type === "string" &&
      chorePayload.type.trim() !== ""
        ? chorePayload.type
        : "chore",
    choreId:
      typeof chorePayload.choreId === "number" &&
      Number.isFinite(chorePayload.choreId)
        ? chorePayload.choreId
        : null,
    autoAssigned: false,
    source: chorePayload.source ?? "manual-drag",
  };
  if (taskRecord.description === "") {
    return false;
  }
  employee.tasks.push(taskRecord);
  if (typeof renderSchedule === "function") {
    renderSchedule();
  }
  if (typeof saveSchedule === "function") {
    saveSchedule();
  }
  return true;
}

function removeChoreFromEmployee(employeeIndex, taskIndex) {
  if (
    !Number.isInteger(employeeIndex) ||
    !Number.isInteger(taskIndex) ||
    !scheduleData.employees ||
    !scheduleData.employees[employeeIndex]
  ) {
    return false;
  }
  const employee = scheduleData.employees[employeeIndex];
  if (!Array.isArray(employee.tasks) || taskIndex < 0) {
    return false;
  }
  if (taskIndex >= employee.tasks.length) {
    return false;
  }
  employee.tasks.splice(taskIndex, 1);
  if (typeof renderSchedule === "function") {
    renderSchedule();
  }
  if (typeof saveSchedule === "function") {
    saveSchedule();
  }
  return true;
}

function handleTaskCellDragEnter(event) {
  const chore = parseDraggedChore(event);
  if (!chore) {
    return;
  }
  event.preventDefault();
  const cell = event.currentTarget;
  const depth = parseInt(cell.dataset.dragDepth ?? "0", 10) + 1;
  cell.dataset.dragDepth = String(depth);
  cell.classList.add("task-cell--droppable");
}

function handleTaskCellDragOver(event) {
  const chore = parseDraggedChore(event);
  if (!chore) {
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
}

function handleTaskCellDragLeave(event) {
  const cell = event.currentTarget;
  const depth = parseInt(cell.dataset.dragDepth ?? "0", 10) - 1;
  if (depth <= 0) {
    cell.dataset.dragDepth = "0";
    cell.classList.remove("task-cell--droppable");
  } else {
    cell.dataset.dragDepth = String(depth);
  }
}

function handleTaskCellDrop(event) {
  const cell = event.currentTarget;
  cell.dataset.dragDepth = "0";
  cell.classList.remove("task-cell--droppable");
  event.preventDefault();
  const employeeIndex = parseInt(
    cell.getAttribute("data-employee-index") || "",
    10,
  );
  const chore = parseDraggedChore(event);
  assignChoreToEmployee(employeeIndex, chore);
}

function makeTaskCellDroppable(cell) {
  if (!cell) {
    return;
  }
  cell.dataset.dragDepth = "0";
  cell.addEventListener("dragenter", handleTaskCellDragEnter);
  cell.addEventListener("dragover", handleTaskCellDragOver);
  cell.addEventListener("dragleave", handleTaskCellDragLeave);
  cell.addEventListener("drop", handleTaskCellDrop);
}

function findBreakEntryByType(breaks, index, type) {
  if (!Array.isArray(breaks)) {
    return null;
  }
  for (let i = 0; i < breaks.length; i += 1) {
    const candidate = breaks[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const candidateType = candidate.type || BREAK_TYPE_CONFIG[i]?.type || null;
    if (candidateType === type) {
      return candidate;
    }
  }
  const fallback = breaks[index];
  return fallback && typeof fallback === "object" ? fallback : null;
}

function breakIsSkipped(employee, entry, config) {
  if (!config || !config.type) {
    return false;
  }
  const suffix = config.type.charAt(0).toUpperCase() + config.type.slice(1);
  return (
    coerceBoolean(entry?.skip) ||
    coerceBoolean(entry?.skipped) ||
    coerceBoolean(employee?.[`${config.type}Skipped`]) ||
    coerceBoolean(employee?.[`${config.type}Skip`]) ||
    coerceBoolean(employee?.[`skip${suffix}`])
  );
}

function getBreakDisplayState(employee, type) {
  const configIndex = BREAK_TYPE_CONFIG.findIndex((item) => item.type === type);
  const config =
    configIndex >= 0
      ? BREAK_TYPE_CONFIG[configIndex]
      : { type, durationField: `${type}Duration` };
  const breaks = Array.isArray(employee.breaks) ? employee.breaks : [];
  const entry = findBreakEntryByType(breaks, configIndex, config.type) || {};
  const skipped = breakIsSkipped(employee, entry, config);
  const start = skipped ? "" : entry.start || employee?.[type] || "";
  const duration = skipped
    ? ""
    : entry.duration ?? employee?.[config.durationField] ?? "";
  return { skipped, start, duration };
}

function formatBreakDurationLabel(duration, skipped) {
  if (skipped) {
    return "(Skipped)";
  }
  if (duration === null || duration === undefined || duration === "") {
    return "";
  }
  const numeric = parseInt(duration, 10);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return `(${numeric} min)`;
  }
  return `(${duration})`;
}

function hasExplicitBreakData(employee) {
  if (!employee) {
    return false;
  }
  if (employee.hasManualBreaks) {
    return true;
  }
  if (
    coerceBoolean(employee.break1Skipped) ||
    coerceBoolean(employee.lunchSkipped) ||
    coerceBoolean(employee.break2Skipped)
  ) {
    return true;
  }
  if (
    Array.isArray(employee.breaks) &&
    employee.breaks.some((br, idx) => {
      if (!br || typeof br !== "object") {
        return false;
      }
      const config = BREAK_TYPE_CONFIG[idx] ?? {
        type: br.type,
      };
      if (breakIsSkipped(employee, br, config)) {
        return true;
      }
      return Boolean(br.start && br.duration);
    })
  ) {
    return true;
  }
  return Boolean(
    employee.break1 &&
      employee.break1Duration &&
      employee.lunch &&
      employee.lunchDuration &&
      employee.break2 &&
      employee.break2Duration,
  );
}

function scheduleNeedsAutoBreaks() {
  if (!Array.isArray(scheduleData.employees)) {
    return false;
  }
  return scheduleData.employees.some((emp) => !hasExplicitBreakData(emp));
}

function getEmployeeBreaks(employee) {
  const resolved = [];
  const rawBreaks = Array.isArray(employee.breaks) ? employee.breaks : [];
  BREAK_TYPE_CONFIG.forEach((config, idx) => {
    const entry = findBreakEntryByType(rawBreaks, idx, config.type);
    if (breakIsSkipped(employee, entry, config)) {
      return;
    }
    const start = entry?.start || employee?.[config.type] || "";
    const duration =
      entry?.duration ?? employee?.[config.durationField] ?? "";
    if (start && duration) {
      resolved.push({
        start,
        duration,
        type: config.type,
      });
    }
  });
  return resolved;
}

function loadTemplates() {
  return Promise.resolve();
}

function setTemplates(list) {
  templateList = Array.isArray(list) ? list : [];
  window.templateList = templateList;
  populateTemplateSelector();
}

function populateTemplateSelector() {
  if (!templateSelector) return;
  templateSelector.replaceChildren();
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Load Template...";
  templateSelector.appendChild(def);
  templateList.forEach(function (tpl) {
    const opt = document.createElement("option");
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    templateSelector.appendChild(opt);
  });
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getChoreDisplayName(task) {
  if (!task || typeof task !== "object") {
    return "";
  }
  const name = (task.name ?? "").trim();
  if (name !== "") {
    return name;
  }
  const description = (task.description ?? "").trim();
  if (description !== "") {
    return description;
  }
  if (typeof task.id === "number") {
    return `Chore #${task.id}`;
  }
  return "Unnamed chore";
}

function extractTimeComponents(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  let value = String(raw).trim();
  if (value === "") {
    return null;
  }
  if (value.includes(" ")) {
    const parts = value.split(" ");
    value = parts[parts.length - 1];
  }
  const ampmMatch = value.match(/am|pm/i);
  let hours;
  let minutes;
  if (ampmMatch) {
    const cleaned = value.replace(/[^0-9:]/g, "");
    const pieces = cleaned.split(":");
    hours = parseInt(pieces[0] || "0", 10);
    minutes = parseInt(pieces[1] || "0", 10);
    const isPM = /pm/i.test(value);
    const isAM = /am/i.test(value);
    if (isPM && hours < 12) {
      hours += 12;
    }
    if (isAM && hours === 12) {
      hours = 0;
    }
  } else {
    const match = value.match(/^(\d{1,2})(?::(\d{2}))?/);
    if (!match) {
      return null;
    }
    hours = parseInt(match[1], 10);
    minutes = parseInt(match[2] || "0", 10);
  }
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }
  hours = ((hours % 24) + 24) % 24;
  minutes = ((minutes % 60) + 60) % 60;
  return { hours, minutes };
}

function formatChoreTime(raw) {
  const components = extractTimeComponents(raw);
  if (!components) {
    return null;
  }
  return formatTimeForDisplay(components.hours, components.minutes);
}

function formatChoreWindow(chore) {
  const start = formatChoreTime(chore.windowStart ?? chore.window_start);
  const end = formatChoreTime(chore.windowEnd ?? chore.window_end);
  if (start && end) {
    return `${start} – ${end}`;
  }
  if (start) {
    return `After ${start}`;
  }
  if (end) {
    return `Before ${end}`;
  }
  const daypart = (chore.daypart ?? chore.dayPart ?? "").trim();
  return daypart !== "" ? daypart : null;
}

function formatChoreDeadline(chore) {
  const deadline = formatChoreTime(chore.deadlineTime ?? chore.deadline_time);
  if (!deadline) {
    return null;
  }
  const leadTime = parseInt(chore.leadTimeMinutes ?? chore.lead_time_minutes, 10);
  if (!Number.isNaN(leadTime) && leadTime > 0) {
    return `Deadline ${deadline} (lead ${leadTime}m)`;
  }
  return `Deadline ${deadline}`;
}

function formatChoreDays(chore) {
  if (!Array.isArray(chore.showOnDays) || chore.showOnDays.length === 0) {
    return null;
  }
  const labels = chore.showOnDays
    .map((day) => {
      const index = parseInt(day, 10);
      if (Number.isNaN(index) || index < 0 || index > 6) {
        return null;
      }
      return DAY_NAMES[index];
    })
    .filter(Boolean);
  if (labels.length === 0) {
    return null;
  }
  return `Days ${labels.join("/")}`;
}

function formatChoreFrequency(chore) {
  const frequency = (chore.frequency ?? "").toLowerCase();
  if (frequency === "") {
    return null;
  }
  const interval = parseInt(chore.recurrenceInterval ?? chore.recurrence_interval, 10);
  if (!Number.isNaN(interval) && interval > 1) {
    if (frequency === "daily") {
      return `Every ${interval} days`;
    }
    if (frequency === "weekly") {
      return `Every ${interval} weeks`;
    }
    if (frequency === "monthly") {
      return `Every ${interval} months`;
    }
    if (frequency === "per_shift") {
      return `Every ${interval} shifts`;
    }
  }
  if (frequency === "per_shift") {
    return "Per shift";
  }
  if (frequency === "once") {
    return "One-time";
  }
  if (frequency === "weekly" || frequency === "monthly" || frequency === "daily") {
    return frequency.charAt(0).toUpperCase() + frequency.slice(1);
  }
  return null;
}

function buildChoreBadges(task) {
  if (!task || typeof task !== "object") {
    return [];
  }
  const badges = [];
  const priority = parseInt(task.priority, 10);
  if (!Number.isNaN(priority) && priority !== 0) {
    badges.push(`Priority ${priority}`);
  }
  const windowLabel = formatChoreWindow(task);
  if (windowLabel) {
    badges.push(windowLabel);
  }
  const days = formatChoreDays(task);
  if (days) {
    badges.push(days);
  }
  const frequency = formatChoreFrequency(task);
  if (frequency) {
    badges.push(frequency);
  }
  const deadline = formatChoreDeadline(task);
  if (deadline) {
    badges.push(deadline);
  }
  if (task.excludeCloser) {
    badges.push("No closers");
  }
  if (task.excludeOpener) {
    badges.push("No openers");
  }
  const minStaff = parseInt(task.minStaffLevel ?? task.min_staff_level, 10);
  if (!Number.isNaN(minStaff) && minStaff > 0) {
    badges.push(`Min staff ${minStaff}`);
  }
  const maxPerDay = parseInt(task.maxPerDay ?? task.max_per_day, 10);
  if (!Number.isNaN(maxPerDay) && maxPerDay > 0) {
    badges.push(`Cap ${maxPerDay}/day`);
  }
  const maxPerShift = parseInt(task.maxPerShift ?? task.max_per_shift, 10);
  if (!Number.isNaN(maxPerShift) && maxPerShift > 0) {
    badges.push(`Max ${maxPerShift}/shift`);
  }
  const maxPerEmployee = parseInt(
    task.maxPerEmployeePerDay ?? task.max_per_employee_per_day,
    10,
  );
  if (!Number.isNaN(maxPerEmployee) && maxPerEmployee > 0) {
    badges.push(`Max ${maxPerEmployee}/person`);
  }
  const duration = parseInt(
    task.estimatedDurationMinutes ?? task.estimated_duration_minutes,
    10,
  );
  if (!Number.isNaN(duration) && duration > 0) {
    badges.push(`≈${duration} min`);
  }
  return badges;
}

function renderChoreBadges(container, badges) {
  container.replaceChildren();
  if (!Array.isArray(badges) || badges.length === 0) {
    container.classList.add("chore-badges--empty");
    return;
  }
  container.classList.remove("chore-badges--empty");
  badges.forEach((text) => {
    const badge = document.createElement("span");
    badge.className = "chore-badge";
    badge.textContent = text;
    container.appendChild(badge);
  });
}

async function fetchBreakPolicy(storeId) {
  try {
    const res = await fetch(
      `admin-api/settings.php?token=${encodeURIComponent(
        API_TOKEN,
      )}&company_id=${COMPANY_ID}&store_id=${storeId}&break=1`,
    );
    const data = await res.json();
    if (data && typeof data === "object") {
      setBreakPolicy(data);
    }
  } catch (err) {}
}

if (templateSelector) {
  templateSelector.addEventListener("change", async function (e) {
    const id = parseInt(e.target.value, 10);
    if (!id) return;
    const tpl = templateList.find(function (t) {
      return t.id === id;
    });
    if (!tpl) return;
    try {
      scheduleMap = JSON.parse(tpl.payload);
    } catch (err) {
      scheduleMap = {};
    }
    if (tpl.breakPolicy) {
      setBreakPolicy(tpl.breakPolicy);
    } else {
      await fetchBreakPolicy(currentStoreId);
    }
    switchToCurrentDate();
    await recomputeBreaks();
    showToast("success", "Template loaded");
  });
}

async function refreshScheduleOutputs(options = {}) {
  const request =
    typeof options === "string" ? { reason: options } : { ...options };
  if (!request.reason) {
    request.reason = "manual";
  }
  try {
    return await assignmentController.refresh(request);
  } catch (error) {
    console.error("Failed to refresh schedule outputs", error);
    if (typeof showToast === "function") {
      showToast("error", "Unable to refresh the schedule");
    }
    throw error;
  }
}

async function recomputeBreaks(options = {}) {
  const request =
    typeof options === "string" ? { reason: options } : { ...options };
  request.forceBreakRecompute = true;
  if (!request.reason) {
    request.reason = "breaks:recompute";
  }
  return refreshScheduleOutputs(request);
}

function shouldIncludeInBreakRun(employee, request) {
  if (!employee || typeof employee !== "object") {
    return false;
  }
  if (employee.hasManualBreaks) {
    return false;
  }
  if (request.forceBreakRecompute) {
    return true;
  }
  return !hasExplicitBreakData(employee);
}

async function ensureBreakPolicyLoaded() {
  if (!scheduleMap.breakPolicy) {
    await fetchBreakPolicy(currentStoreId);
  }
  return getBreakPolicy();
}

function parseShiftBoundsForAssignments(shiftText) {
  if (typeof shiftText !== "string" || shiftText.trim() === "") {
    return { startMinutes: null, endMinutes: null };
  }
  const parts = shiftText.split("-");
  if (parts.length < 2) {
    return { startMinutes: null, endMinutes: null };
  }
  const startHours = parseTimeString(parts[0].trim());
  const endHours = parseTimeString(parts[1].trim());
  const startMinutes = Number.isFinite(startHours)
    ? Math.round(startHours * 60)
    : null;
  let endMinutes = Number.isFinite(endHours)
    ? Math.round(endHours * 60)
    : null;
  if (
    startMinutes !== null &&
    endMinutes !== null &&
    endMinutes <= startMinutes
  ) {
    endMinutes += 24 * 60;
  }
  return { startMinutes, endMinutes };
}

function coerceBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return null;
    }
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return null;
}

function readFlagFromSources(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of keys) {
      if (!(key in source)) {
        continue;
      }
      const coerced = coerceBoolean(source[key]);
      if (coerced !== null) {
        return coerced;
      }
    }
  }
  return null;
}

const MANUAL_CLOSER_KEYS = ["isCloser", "is_closer", "closer"];
const MANUAL_OPENER_KEYS = ["isOpener", "is_opener", "opener"];
const AUTO_MANAGED_ASSIGNMENT_KEYS = Array.from(
  new Set([...MANUAL_CLOSER_KEYS, ...MANUAL_OPENER_KEYS]),
);
const TEXT_CLOSER_PATTERNS = [/\bcloser\b/i, /\bclose\b/i];
const TEXT_OPENER_PATTERNS = [/\bopener\b/i, /\bopen\b/i];

function prepareMetadataSourceForAssignments(source) {
  if (!source || typeof source !== "object") {
    return null;
  }
  if (!source.assignmentAutoManaged) {
    return source;
  }
  const sanitized = { ...source };
  AUTO_MANAGED_ASSIGNMENT_KEYS.forEach((key) => {
    if (key in sanitized) {
      delete sanitized[key];
    }
  });
  return sanitized;
}

function valueContainsKeyword(value, patterns) {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsKeyword(item, patterns));
  }
  if (typeof value === "object") {
    return Object.values(value).some((item) =>
      valueContainsKeyword(item, patterns),
    );
  }
  const text = String(value).toLowerCase();
  if (text.trim() === "") {
    return false;
  }
  return patterns.some((pattern) => pattern.test(text));
}

function deriveShiftAssignments(employees) {
  const windowMinutes = 90;
  const descriptors = employees.map((employee, index) => {
    const metadataSources = [];
    if (employee && typeof employee === "object") {
      [employee.metadata, employee.meta].forEach((candidate) => {
        const prepared = prepareMetadataSourceForAssignments(candidate);
        if (prepared) {
          metadataSources.push(prepared);
        }
      });
    }
    const manualCloser = readFlagFromSources(
      [...metadataSources, employee],
      MANUAL_CLOSER_KEYS,
    );
    const manualOpener = readFlagFromSources(
      [...metadataSources, employee],
      MANUAL_OPENER_KEYS,
    );
    const textSources = [
      employee?.positions,
      employee?.position,
      employee?.pos,
      employee?.signOff,
      employee?.shift,
    ];
    metadataSources.forEach((meta) => {
      textSources.push(meta.positions, meta.position, meta.roles, meta.skills);
    });
    const hasCloseText = valueContainsKeyword(
      textSources,
      TEXT_CLOSER_PATTERNS,
    );
    const hasOpenText = valueContainsKeyword(textSources, TEXT_OPENER_PATTERNS);
    const bounds = parseShiftBoundsForAssignments(employee?.shift ?? "");
    return {
      index,
      manualCloser,
      manualOpener,
      hasCloseText,
      hasOpenText,
      ...bounds,
    };
  });

  let latestEnd = null;
  descriptors.forEach((descriptor) => {
    if (descriptor.endMinutes !== null) {
      if (latestEnd === null || descriptor.endMinutes > latestEnd) {
        latestEnd = descriptor.endMinutes;
      }
    }
  });

  descriptors.forEach((descriptor) => {
    let autoCloser = descriptor.hasCloseText;
    if (
      latestEnd !== null &&
      descriptor.endMinutes !== null &&
      descriptor.endMinutes >= latestEnd - windowMinutes &&
      descriptor.endMinutes <= latestEnd
    ) {
      autoCloser = true;
    }
    descriptor.autoCloser = autoCloser;
  });

  let earliestStart = null;
  descriptors.forEach((descriptor) => {
    if (descriptor.startMinutes !== null) {
      if (earliestStart === null || descriptor.startMinutes < earliestStart) {
        earliestStart = descriptor.startMinutes;
      }
    }
  });

  descriptors.forEach((descriptor) => {
    let autoOpener = descriptor.hasOpenText;
    if (
      !autoOpener &&
      earliestStart !== null &&
      descriptor.startMinutes !== null &&
      descriptor.startMinutes <= earliestStart + windowMinutes
    ) {
      autoOpener = true;
    }
    descriptor.autoOpener = autoOpener;
  });

  return descriptors.map((descriptor) => {
    const autoIsCloser = Boolean(descriptor.autoCloser);
    let autoIsOpener = Boolean(descriptor.autoOpener);
    if (autoIsCloser) {
      autoIsOpener = false;
    }
    const finalCloser =
      descriptor.manualCloser !== null
        ? descriptor.manualCloser
        : autoIsCloser;
    let finalOpener =
      descriptor.manualOpener !== null
        ? descriptor.manualOpener
        : autoIsOpener;
    if (finalCloser && descriptor.manualOpener === null) {
      finalOpener = false;
    }
    return {
      index: descriptor.index,
      autoIsCloser,
      autoIsOpener,
      isCloser: Boolean(finalCloser),
      isOpener: Boolean(finalOpener),
      manualCloser: descriptor.manualCloser,
      manualOpener: descriptor.manualOpener,
    };
  });
}

assignmentController.registerProvider(
  "breaks",
  async (context, shared) => {
    if (!Array.isArray(scheduleData.employees)) {
      return;
    }
    const request = context.request || {};
    const pending = [];
    scheduleData.employees.forEach((employee, index) => {
      if (!shouldIncludeInBreakRun(employee, request)) {
        return;
      }
      const shiftParts = (employee.shift || "").split("-");
      if (shiftParts.length < 2) {
        return;
      }
      const start = parseTimeString(shiftParts[0].trim());
      if (Number.isNaN(start)) {
        return;
      }
      const lunchDuration = parseInt(employee.lunchDuration, 10);
      pending.push({ index, start, lunchDuration });
    });
    if (pending.length === 0) {
      return;
    }

    const policy = await ensureBreakPolicyLoaded();
    shared.breakPolicy = policy;
    const payload = [];
    const employeeIndexes = [];
    pending.forEach((entry) => {
      const lunchDuration = Number.isFinite(entry.lunchDuration)
        ? entry.lunchDuration
        : policy.lunchDuration || 60;
      payload.push({ start: entry.start, lunchDuration });
      employeeIndexes.push(entry.index);
    });

    if (payload.length === 0) {
      return;
    }

    try {
      const res = await fetch(
        `api/group_breaks.php?token=${encodeURIComponent(
          API_TOKEN,
        )}&company_id=${COMPANY_ID}&store_id=${currentStoreId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ employees: payload, policy }),
        },
      );
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach((br, idx) => {
          const employeeIndex = employeeIndexes[idx];
          if (typeof employeeIndex === "undefined") {
            return;
          }
          const target = scheduleData.employees[employeeIndex];
          if (!target) {
            return;
          }
          const payloadEntry = payload[idx];
          if (!payloadEntry) {
            return;
          }
          const b1 = formatTimeForDisplay(
            Math.floor(br.break1),
            Math.round((br.break1 % 1) * 60),
          );
          const lunch = formatTimeForDisplay(
            Math.floor(br.lunch),
            Math.round((br.lunch % 1) * 60),
          );
          const b2 = formatTimeForDisplay(
            Math.floor(br.break2),
            Math.round((br.break2 % 1) * 60),
          );
          const b1Dur = policy.break1Duration || 10;
          const lunchDur = payloadEntry.lunchDuration;
          const b2Dur = policy.break2Duration || 10;
          target.break1 = b1;
          target.lunch = lunch;
          target.break2 = b2;
          target.break1Duration = String(b1Dur);
          target.lunchDuration = String(lunchDur);
          target.break2Duration = String(b2Dur);
          target.breaks = [
            { start: b1, duration: b1Dur, type: "break1" },
            { start: lunch, duration: lunchDur, type: "lunch" },
            { start: b2, duration: b2Dur, type: "break2" },
          ];
          target.hasManualBreaks = false;
        });
        context.markDirty("breaks");
      }
    } catch (error) {
      console.error("Failed to recompute breaks", error);
    }
  },
  { priority: 10 },
);

assignmentController.registerProvider(
  "shift-tags",
  (context, shared) => {
    if (!Array.isArray(scheduleData.employees) || scheduleData.employees.length === 0) {
      return;
    }
    const assignments = deriveShiftAssignments(scheduleData.employees);
    assignments.forEach((assignment) => {
      const employee = scheduleData.employees[assignment.index];
      if (!employee) {
        return;
      }
      const metadata =
        employee.metadata && typeof employee.metadata === "object"
          ? { ...employee.metadata }
          : {};
      metadata.autoIsCloser = assignment.autoIsCloser;
      metadata.autoIsOpener = assignment.autoIsOpener;
      metadata.isCloser = assignment.isCloser;
      metadata.isOpener = assignment.isOpener;
      metadata.assignmentRole = assignment.isCloser
        ? "closer"
        : assignment.isOpener
          ? "opener"
          : "standard";
      metadata.assignmentTags = {
        isCloser: assignment.isCloser,
        isOpener: assignment.isOpener,
      };
      metadata.assignmentAutoManaged = true;
      employee.metadata = metadata;
      if (employee.meta && typeof employee.meta === "object") {
        employee.meta = {
          ...employee.meta,
          autoIsCloser: metadata.autoIsCloser,
          autoIsOpener: metadata.autoIsOpener,
          assignmentRole: metadata.assignmentRole,
          assignmentTags: metadata.assignmentTags,
          assignmentAutoManaged: true,
        };
        if ("isCloser" in metadata) {
          employee.meta.isCloser = metadata.isCloser;
        }
        if ("isOpener" in metadata) {
          employee.meta.isOpener = metadata.isOpener;
        }
      }
    });
    shared.shiftAssignments = assignments;
    context.markDirty("shift-tags");
  },
  { priority: 20 },
);

assignmentController.registerProvider(
  "pos-normalization",
  (context, shared) => {
    if (!Array.isArray(scheduleData.employees)) {
      return;
    }
    const assignments = {};
    scheduleData.employees.forEach((employee, index) => {
      if (!employee) {
        return;
      }
      if (typeof employee.pos === "string") {
        const trimmed = employee.pos.trim();
        if (trimmed !== employee.pos) {
          employee.pos = trimmed;
        }
      } else if (employee.pos === null || employee.pos === undefined) {
        employee.pos = "";
      } else {
        employee.pos = String(employee.pos);
      }
      if (employee.pos !== "") {
        if (!assignments[employee.pos]) {
          assignments[employee.pos] = [];
        }
        assignments[employee.pos].push(index);
      }
    });
    scheduleData.posAssignments = assignments;
    shared.posAssignments = assignments;
  },
  { priority: 30 },
);

assignmentController.registerProvider(
  "chores",
  async () => {
    if (typeof refreshChoreAssignments === "function") {
      await refreshChoreAssignments();
    }
  },
  { priority: 40 },
);

assignmentController.registerProvider(
  "ui-sync",
  (context) => {
    if (typeof renderSchedule === "function") {
      renderSchedule();
    }
    if (typeof renderBreakTimeline === "function") {
      renderBreakTimeline();
    }
    if (typeof updateScheduleSummary === "function") {
      updateScheduleSummary();
    }
    if (typeof renderGeneralTasks === "function") {
      renderGeneralTasks();
    }
    if (typeof updateRecyclingTaskVisibility === "function") {
      updateRecyclingTaskVisibility();
    }
    if (typeof populateEmployeeSelector === "function") {
      populateEmployeeSelector();
    }
    if (!context.request || context.request.skipSave !== true) {
      if (typeof saveSchedule === "function") {
        saveSchedule();
      }
    }
  },
  { priority: 50 },
);

// Toggle employee name dropdown
function toggleEmployeeNameDropdown(index, element) {
  // Position dropdown
  const rect = element.getBoundingClientRect();
  employeeNameDropdown.style.top = `${rect.bottom + window.scrollY}px`;
  employeeNameDropdown.style.left = `${rect.left + window.scrollX}px`;

  // Populate dropdown
  populateEmployeeNameDropdown(index);

  // Show dropdown
  employeeNameDropdown.classList.add("show");
  activeEmployeeDropdown = index;
}

// Populate employee name dropdown
function populateEmployeeNameDropdown(index) {
  employeeNameDropdown.replaceChildren();

  const currentEmployee = scheduleData.employees[index];

  // Add all employees to dropdown
  employeeList.forEach((employee) => {
    const option = document.createElement("div");
    option.className = `employee-option ${employee.id === currentEmployee.id ? "selected" : ""}`;
    option.setAttribute("data-employee-id", employee.id);
    option.textContent = employee.name;
    employeeNameDropdown.appendChild(option);
  });
}

// Change employee
async function changeEmployee(index, newEmployeeId) {
  const oldEmployeeId = scheduleData.employees[index].id;

  // Find new employee in list
  const newEmployee = employeeList.find((emp) => emp.id === newEmployeeId);

  if (!newEmployee) {
    showToast("error", "Employee not found");
    return;
  }

  // Update employee name
  scheduleData.employees[index].id = newEmployee.id;
  scheduleData.employees[index].name = newEmployee.name;

  // Update UI
  await refreshScheduleOutputs();

  // Show success message
  showToast("success", `Employee changed to ${newEmployee.name}`);
}

// Populate employee selector with available employees
function populateEmployeeSelector() {
  employeeSelector.replaceChildren();
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Add Employee...";
  employeeSelector.appendChild(def);

  // Filter out employees already in the schedule
  const scheduledEmployeeIds = scheduleData.employees.map((emp) => emp.id);
  const availableEmployees = employeeList.filter(
    (emp) => !scheduledEmployeeIds.includes(emp.id),
  );

  availableEmployees.forEach((employee) => {
    const option = document.createElement("option");
    option.value = employee.id;
    option.textContent = employee.name;
    employeeSelector.appendChild(option);
  });
}

// Setup drag and drop functionality
function setupDragAndDrop() {
  const rows = document.querySelectorAll("#scheduleBody tr");

  rows.forEach((row) => {
    // Make row draggable
    row.setAttribute("draggable", "true");

    // Add drag start event
    row.addEventListener("dragstart", (e) => {
      draggedElement = row;
      row.classList.add("dragging");

      // Set data transfer
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(
        "text/plain",
        row.getAttribute("data-employee-index"),
      );
    });

    // Add drag end event
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      draggedElement = null;

      // Remove drag-over class from all rows
      rows.forEach((r) => r.classList.remove("drag-over"));
    });

    // Add drag over event
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (draggedElement && draggedElement !== row) {
        row.classList.add("drag-over");
      }
    });

    // Add drag leave event
    row.addEventListener("dragleave", () => {
      row.classList.remove("drag-over");
    });

    // Add drop event
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");

      if (draggedElement) {
        const fromIndex = parseInt(
          draggedElement.getAttribute("data-employee-index"),
        );
        const toIndex = parseInt(row.getAttribute("data-employee-index"));

        if (fromIndex !== toIndex) {
          // Reorder employees
          reorderEmployees(fromIndex, toIndex);
        }
      }
    });
  });
}

// Reorder employees
async function reorderEmployees(fromIndex, toIndex) {
  // Get the employee to move
  const employeeToMove = scheduleData.employees[fromIndex];

  // Remove the employee from the original position
  scheduleData.employees.splice(fromIndex, 1);

  // Insert the employee at the new position
  scheduleData.employees.splice(toIndex, 0, employeeToMove);

  // Update UI
  await refreshScheduleOutputs();

  // Show success message
  showToast("success", `Employee order updated`);
}

// Render schedule
function renderSchedule() {
  scheduleBody.replaceChildren();

  scheduleData.employees.forEach((employee, index) => {
    const rowClass = index % 2 === 0 ? "schedule-row-odd" : "schedule-row-even";

    const row = document.createElement("tr");
    row.className = `${rowClass} border-b border-gray-200 draggable`;
    row.setAttribute("data-employee-index", index);
    row.setAttribute("data-employee-id", employee.id);

    const dragTd = document.createElement("td");
    dragTd.className = "py-3 px-4";
    const dragDiv = document.createElement("div");
    dragDiv.className = "drag-handle";
    const dragImg = document.createElement("img");
    dragImg.src =
      "https://raw.githubusercontent.com/tailwindlabs/heroicons/v2.2.0/optimized/24/outline/bars-3.svg";
    dragImg.className = "h-5 w-5";
    dragImg.alt = "menu";
    dragDiv.appendChild(dragImg);
    dragTd.appendChild(dragDiv);
    row.appendChild(dragTd);

    const nameTd = document.createElement("td");
    nameTd.className = "py-3 px-4";
    const nameContainer = document.createElement("div");
    nameContainer.className = "d-flex align-items-center";
    const nameDiv = document.createElement("div");
    nameDiv.className = "employee-name d-flex align-items-center flex-grow-1";
    nameDiv.setAttribute("data-index", index);
    const nameSpan = document.createElement("span");
    nameSpan.className = "flex-grow-1";
    nameSpan.textContent = employee.name;
    const downImg = document.createElement("img");
    downImg.src =
      "https://raw.githubusercontent.com/tailwindlabs/heroicons/v2.2.0/optimized/24/outline/chevron-down.svg";
    downImg.className = "ms-1 h-4 w-4 flex-shrink-0";
    downImg.alt = "down";
    nameDiv.append(nameSpan, downImg);
    nameContainer.appendChild(nameDiv);
    nameTd.appendChild(nameContainer);
    row.appendChild(nameTd);

    const shiftTd = document.createElement("td");
    shiftTd.className = "py-3 px-4";
    const shiftDiv = document.createElement("div");
    shiftDiv.className = "flex items-center";
    const shiftSpan = document.createElement("span");
    shiftSpan.textContent = employee.shift;
    const shiftBtn = document.createElement("button");
    shiftBtn.className =
      "ml-2 shift-edit-btn no-print btn btn-outline-secondary btn-sm inline-flex items-center";
    shiftBtn.setAttribute("data-index", index);
    const shiftIcon = document.createElement("img");
    shiftIcon.src =
      "https://raw.githubusercontent.com/tailwindlabs/heroicons/v2.2.0/optimized/24/outline/pencil.svg";
    shiftIcon.className = "h-4 w-4 mr-1";
    shiftIcon.alt = "edit";
    shiftBtn.appendChild(shiftIcon);
    shiftBtn.appendChild(document.createTextNode("Edit"));
    shiftDiv.append(shiftSpan, shiftBtn);
    shiftTd.appendChild(shiftDiv);
    row.appendChild(shiftTd);

    const posTd = document.createElement("td");
    posTd.className = "py-3 px-4";
    const posDiv = document.createElement("div");
    posDiv.className = "flex items-center";
    const posSpan = document.createElement("span");
    posSpan.textContent = employee.pos;
    const posBtn = document.createElement("button");
    posBtn.className = "ml-2 pos-edit-btn no-print btn";
    posBtn.setAttribute("data-index", index);
    const posIcon = document.createElement("img");
    posIcon.src =
      "https://raw.githubusercontent.com/tailwindlabs/heroicons/v2.2.0/optimized/24/outline/pencil.svg";
    posIcon.className = "h-4 w-4";
    posIcon.alt = "edit";
    posBtn.appendChild(posIcon);
    posDiv.append(posSpan, posBtn);
    posTd.appendChild(posDiv);
    row.appendChild(posTd);

    const break1State = getBreakDisplayState(employee, "break1");
    const lunchState = getBreakDisplayState(employee, "lunch");
    const break2State = getBreakDisplayState(employee, "break2");

    const b1Td = document.createElement("td");
    b1Td.className = "py-3 px-4";
    const b1Div = document.createElement("div");
    b1Div.className = "flex items-center";
    const b1Span = document.createElement("span");
    b1Span.textContent = break1State.skipped ? "X" : break1State.start;
    const b1Btn = document.createElement("button");
    b1Btn.className = "ml-2 break-edit-btn no-print btn";
    b1Btn.setAttribute("data-index", index);
    const b1Icon = document.createElement("img");
    b1Icon.src =
      "https://raw.githubusercontent.com/tailwindlabs/heroicons/v2.2.0/optimized/24/outline/pencil.svg";
    b1Icon.className = "h-4 w-4";
    b1Icon.alt = "edit";
    b1Btn.appendChild(b1Icon);
    b1Div.append(b1Span, b1Btn);
    b1Td.appendChild(b1Div);
    const b1Info = document.createElement("div");
    b1Info.className = "text-xs text-gray-600";
    b1Info.textContent = formatBreakDurationLabel(
      break1State.duration,
      break1State.skipped,
    );
    b1Td.appendChild(b1Info);
    row.appendChild(b1Td);

    const lunchTd = document.createElement("td");
    lunchTd.className = "py-3 px-4";
    const lunchDiv = document.createElement("div");
    lunchDiv.className = "flex items-center";
    const lunchSpan = document.createElement("span");
    lunchSpan.textContent = lunchState.skipped ? "X" : lunchState.start;
    lunchDiv.appendChild(lunchSpan);
    lunchTd.appendChild(lunchDiv);
    const lunchInfo = document.createElement("div");
    lunchInfo.className = "text-xs text-gray-600";
    lunchInfo.textContent = formatBreakDurationLabel(
      lunchState.duration,
      lunchState.skipped,
    );
    lunchTd.appendChild(lunchInfo);
    row.appendChild(lunchTd);

    const b2Td = document.createElement("td");
    b2Td.className = "py-3 px-4";
    const b2Div = document.createElement("div");
    b2Div.className = "flex items-center";
    const b2Span = document.createElement("span");
    b2Span.textContent = break2State.skipped ? "X" : break2State.start;
    b2Div.appendChild(b2Span);
    b2Td.appendChild(b2Div);
    const b2Info = document.createElement("div");
    b2Info.className = "text-xs text-gray-600";
    b2Info.textContent = formatBreakDurationLabel(
      break2State.duration,
      break2State.skipped,
    );
    b2Td.appendChild(b2Info);
    row.appendChild(b2Td);

    const taskTd = document.createElement("td");
    taskTd.className = "py-3 px-4 task-cell";
    taskTd.setAttribute("data-employee-index", index);
    const taskDiv = document.createElement("div");
    const chorePills = renderTaskPills(employee.tasks, index);
    if (chorePills.childNodes.length > 0) {
      taskDiv.appendChild(chorePills);
    }
    taskTd.appendChild(taskDiv);
    makeTaskCellDroppable(taskTd);
    row.appendChild(taskTd);

    const delTd = document.createElement("td");
    delTd.className = "py-3 px-4 no-print";
    const delBtn = document.createElement("button");
    delBtn.className = "delete-employee btn";
    delBtn.setAttribute("data-index", index);
    delBtn.setAttribute("data-employee-id", employee.id);
    const delIcon = document.createElement("img");
    delIcon.src =
      "https://raw.githubusercontent.com/tailwindlabs/heroicons/v2.2.0/optimized/24/outline/trash.svg";
    delIcon.className = "h-5 w-5";
    delIcon.alt = "delete";
    delBtn.appendChild(delIcon);
    delTd.appendChild(delBtn);
    row.appendChild(delTd);

    scheduleBody.appendChild(row);
  });

  setupDragAndDrop();
  updateScheduleSummary();
}

// Render break timeline
function renderBreakTimeline() {
  // Create the timeline container if it doesn't exist
  if (!document.getElementById("breakTimelineContainer")) {
    return;
  }

  // Clear existing timeline
  breakTimelineContainer.replaceChildren();

  const policy = getBreakPolicy();

  // Create a timeline for each employee
  scheduleData.employees.forEach((employee) => {
    const timelineRow = document.createElement("div");
    timelineRow.className = "flex items-center mb-2";

    // Employee name label (truncated if needed)
    const nameLabel = document.createElement("div");
    nameLabel.className =
      "w-20 text-xs font-medium text-gray-700 mr-2 truncate";
    nameLabel.textContent = employee.name;

    // Timeline container
    const timeline = document.createElement("div");
    timeline.className = "break-timeline flex-grow";

    // Calculate time positions (7AM to 10PM = 15 hours)
    const timelineStart = 7; // 7AM
    const timelineEnd = 22; // 10PM
    const timelineRange = timelineEnd - timelineStart;

    // Add break segments from array
    getEmployeeBreaks(employee).forEach((br) => {
      const time = parseTimeString(br.start);
      const dur = (parseInt(br.duration, 10) || 0) / 60;
      if (time >= timelineStart && time <= timelineEnd && dur > 0) {
        const seg = document.createElement("div");
        const typeClass =
          br.type === "lunch"
            ? "lunch-segment"
            : br.type === "break2"
              ? "break2-segment"
              : "break1-segment";
        seg.className = `break-segment ${typeClass}`;
        const pos = ((time - timelineStart) / timelineRange) * 100;
        const width = (dur / timelineRange) * 100;
        seg.style.left = `${pos}%`;
        seg.style.width = `${width}%`;
        timeline.appendChild(seg);
      }
    });

    // Add the elements to the row
    timelineRow.appendChild(nameLabel);
    timelineRow.appendChild(timeline);

    // Add the row to the container
    breakTimelineContainer.appendChild(timelineRow);
  });

  // Add overlap indicators
  addBreakOverlapIndicators();
}

// Add break overlap indicators to the timeline
function addBreakOverlapIndicators() {
  const policy = getBreakPolicy();
  const maxConcurrent = policy.maxConcurrent || 1;

  const events = [];
  scheduleData.employees.forEach((employee, idx) => {
    getEmployeeBreaks(employee).forEach((br) => {
      const start = parseTimeString(br.start);
      const dur = (parseInt(br.duration, 10) || 0) / 60;
      if (!isNaN(start) && dur > 0) {
        events.push({ time: start, type: "start", idx });
        events.push({ time: start + dur, type: "end", idx });
      }
    });
  });

  events.sort((a, b) => a.time - b.time || (a.type === "end" ? -1 : 1));

  const active = new Set();
  let lastTime = null;
  const segments = [];
  events.forEach((evt) => {
    if (lastTime !== null && active.size > maxConcurrent) {
      segments.push({
        start: lastTime,
        end: evt.time,
        employees: Array.from(active),
      });
    }
    if (evt.type === "start") {
      active.add(evt.idx);
    } else {
      active.delete(evt.idx);
    }
    lastTime = evt.time;
  });

  const timelineStart = 7;
  const timelineEnd = 22;
  const timelineRange = timelineEnd - timelineStart;

  segments.forEach((seg) => {
    seg.employees.forEach((empIdx) => {
      const timeline =
        breakTimelineContainer.children[empIdx].querySelector(
          ".break-timeline",
        );
      const overlapIndicator = document.createElement("div");
      overlapIndicator.className = "break-segment overlap-indicator";
      const overlapPosition =
        ((seg.start - timelineStart) / timelineRange) * 100;
      const overlapWidth = ((seg.end - seg.start) / timelineRange) * 100;
      overlapIndicator.style.left = `${overlapPosition}%`;
      overlapIndicator.style.width = `${overlapWidth}%`;
      timeline.appendChild(overlapIndicator);
    });
  });
}

// Check if two break periods overlap
function doBreaksOverlap(start1, end1, start2, end2) {
  return start1 < end2 && start2 < end1;
}

// Render task pills
function renderTaskPills(tasks, employeeIndex) {
  const frag = document.createDocumentFragment();
  if (!tasks || tasks.length === 0) {
    return frag;
  }
  tasks.forEach((task, index) => {
    let className = "task-pill";
    if (task.type === "recycling") {
      className += " recycling-task";
    } else if (task.type === "arca") {
      className += " arca-task";
    }
    const span = document.createElement("span");
    span.className = className;
    span.setAttribute("data-employee-index", employeeIndex);
    span.setAttribute("data-task-index", index);
    span.textContent = task.description;
    span.setAttribute(
      "aria-label",
      `Remove ${task.description} from schedule`,
    );
    span.setAttribute("role", "button");
    span.tabIndex = 0;
    const removeHandler = () => {
      const empIdx = parseInt(
        span.getAttribute("data-employee-index") || "",
        10,
      );
      const taskIdx = parseInt(
        span.getAttribute("data-task-index") || "",
        10,
      );
      removeChoreFromEmployee(empIdx, taskIdx);
    };
    span.addEventListener("click", (event) => {
      event.preventDefault();
      removeHandler();
    });
    span.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        removeHandler();
      }
    });
    frag.appendChild(span);
  });
  return frag;
}

// Update schedule summary
function updateScheduleSummary() {
  const employees = scheduleData.employees;

  // Total employees
  totalEmployees.textContent = employees.length;

  // Morning and afternoon shifts
  let morningCount = 0;
  let afternoonCount = 0;
  let totalHoursCount = 0;

  employees.forEach((employee) => {
    if (employee.shift) {
      const shiftParts = employee.shift.split("-");
      if (shiftParts.length === 2) {
        const startTime = shiftParts[0].trim();

        // Check if it's a morning shift (starts before 12PM)
        if (startTime.includes("AM") || startTime === "12:00") {
          morningCount++;
        } else {
          afternoonCount++;
        }

        // Calculate hours
        try {
          const startHour = parseTimeString(startTime);
          const endHour = parseTimeString(shiftParts[1].trim());
          let hours = endHour - startHour;

          // Adjust for overnight shifts
          if (hours < 0) {
            hours += 24;
          }

          totalHoursCount += hours;
        } catch (e) {
          console.warn("Could not parse shift time:", employee.shift);
        }
      }
    }
  });

  morningShift.textContent = morningCount;
  afternoonShift.textContent = afternoonCount;
  totalHours.textContent = totalHoursCount.toFixed(1);
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

// Add employee to schedule
async function addEmployee() {
  const employeeId = parseInt(employeeSelector.value);

  if (!employeeId) {
    showToast("error", "Please select an employee to add");
    return;
  }

  // Find employee in list
  const employee = employeeList.find((emp) => emp.id === employeeId);

  if (!employee) {
    showToast("error", "Employee not found");
    return;
  }

  const shift = employee.shift || "9:00 AM-5:00 PM";
  const newEmployee = {
    id: employee.id,
    name: employee.name,
    shift,
    pos: "",
    breaks: [],
    tasks: [],
    signOff: "",
    lunchDuration: String(
      employee.lunchDuration || getBreakPolicy().lunchDuration || 60,
    ),
    hasManualBreaks: false,
  };
  scheduleData.employees.push(newEmployee);
  await recomputeBreaks();
  showToast("success", `${employee.name} added to schedule`);
}

// Delete employee from schedule
async function deleteEmployee(employeeId, index) {
  const employee = scheduleData.employees.splice(index, 1)[0];
  await recomputeBreaks();
  showToast("success", `${employee.name} removed from schedule`);
}

// Render general tasks
function renderGeneralTasks() {
  if (!generalTasksContainer) {
    renderChoreList();
    return;
  }
  // Clear container except for the "Add Task" button
  generalTasksContainer.replaceChildren();

  // Add tasks
  let renderedAny = false;
  (Array.isArray(generalTasks) ? generalTasks : []).forEach((task) => {
    // Check if task should be shown on current day
    const dayOfWeek = currentDate.getDay();
    const shouldShow =
      task.showOnDays === null || task.showOnDays.includes(dayOfWeek);

    if (shouldShow || task.type !== "recycling") {
      // Always show non-recycling tasks
      const taskElement = document.createElement("div");
      taskElement.className = `general-task-item`;
      if (task.type === "recycling") {
        taskElement.id = "recyclingTask";
        if (!shouldShow) {
          taskElement.style.display = "none";
        }
      }
      const header = document.createElement("div");
      header.className = "general-task-header";
      const titleGroup = document.createElement("div");
      titleGroup.className = "general-task-title";
      const img = document.createElement("img");
      img.src =
        "https://raw.githubusercontent.com/tailwindlabs/heroicons/v2.2.0/optimized/24/outline/check.svg";
      img.className = "h-4 w-4";
      img.alt = "check";
      const span = document.createElement("span");
      span.textContent = getChoreDisplayName(task);
      titleGroup.append(img, span);
      header.appendChild(titleGroup);
      if (task.assignedTo) {
        const assignee = employeeList.find((emp) => emp.id === task.assignedTo);
        if (assignee) {
          const assigneeTag = document.createElement("span");
          assigneeTag.className = "general-task-assignee";
          assigneeTag.textContent = `Assigned: ${assignee.name}`;
          header.appendChild(assigneeTag);
        }
      }

      const metadata = document.createElement("div");
      metadata.className = "chore-badges";
      const badges = buildChoreBadges(task);
      renderChoreBadges(metadata, badges);

      taskElement.append(header, metadata);
      generalTasksContainer.appendChild(taskElement);
      renderedAny = true;
    }
  });

  if (!renderedAny) {
    const empty = document.createElement("div");
    empty.className = "text-sm text-gray-600 general-task-empty";
    empty.textContent = "No chores scheduled for today.";
    generalTasksContainer.appendChild(empty);
  }

  // Update recycling task reference and visibility
  recyclingTask = document.getElementById("recyclingTask");
  updateRecyclingTaskVisibility();
  renderChoreList();
}

// Render chore list below tip tracker
function renderChoreList() {
  const listEl = document.getElementById("choreListItems");
  if (!listEl) return;
  listEl.replaceChildren();
  generalTasks.forEach((task) => {
    const li = document.createElement("li");
    li.className = "chore-list-item";
    const title = document.createElement("div");
    title.className = "chore-list-title";
    title.textContent = getChoreDisplayName(task);
    li.appendChild(title);
    if (task.assignedTo) {
      const assignee = employeeList.find((emp) => emp.id === task.assignedTo);
      if (assignee) {
        const assigneeLine = document.createElement("div");
        assigneeLine.className = "chore-list-assignee";
        assigneeLine.textContent = `Assigned: ${assignee.name}`;
        li.appendChild(assigneeLine);
      }
    }
    const badges = buildChoreBadges(task);
    const badgeContainer = document.createElement("div");
    badgeContainer.className = "chore-badges";
    renderChoreBadges(badgeContainer, badges);
    li.draggable = true;
    li.setAttribute("aria-grabbed", "false");
    li.addEventListener("dragstart", (event) => handleChoreDragStart(event, task));
    li.addEventListener("dragend", handleChoreDragEnd);
    if (Array.isArray(badges) && badges.length > 0) {
      badgeContainer.classList.add("chore-badges-collapsed");
      li.classList.add("chore-list-item--expandable");
      li.setAttribute("role", "button");
      li.tabIndex = 0;
      li.setAttribute("aria-expanded", "false");
      badgeContainer.hidden = true;
      const toggle = () => {
        const expanded = li.getAttribute("aria-expanded") === "true";
        const next = !expanded;
        li.setAttribute("aria-expanded", next ? "true" : "false");
        li.classList.toggle("chore-list-item--expanded", next);
        if (next) {
          badgeContainer.classList.remove("chore-badges-collapsed");
          badgeContainer.hidden = false;
        } else {
          badgeContainer.classList.add("chore-badges-collapsed");
          badgeContainer.hidden = true;
        }
      };
      li.addEventListener("click", () => {
        toggle();
      });
      li.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    }
    li.appendChild(badgeContainer);
    listEl.appendChild(li);
  });
}

window.loadTemplates = loadTemplates;
window.setTemplates = setTemplates;
window.fetchBreakPolicy = fetchBreakPolicy;
window.populateEmployeeSelector = populateEmployeeSelector;
window.renderSchedule = renderSchedule;
window.renderBreakTimeline = renderBreakTimeline;
window.doBreaksOverlap = doBreaksOverlap;
window.updateScheduleSummary = updateScheduleSummary;
window.addEmployee = addEmployee;
window.deleteEmployee = deleteEmployee;
window.recomputeBreaks = recomputeBreaks;
window.scheduleNeedsAutoBreaks = scheduleNeedsAutoBreaks;
window.renderGeneralTasks = renderGeneralTasks;
window.renderChoreList = renderChoreList;
window.refreshScheduleOutputs = refreshScheduleOutputs;
