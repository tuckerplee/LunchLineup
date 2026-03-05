import { getBreakPolicy } from "./break-policy.js";

// Open employee edit modal
function openEmployeeEditModal(index) {
  editingEmployeeIndex = index;

  const employee = scheduleData.employees[index];
  document.getElementById("employeeName").value = employee.name;
  document.getElementById("employeeEditModal").classList.remove("hidden");
  document.getElementById("employeeName").focus();
}

// Save employee edit
async function saveEmployeeEdit() {
  const name = document.getElementById("employeeName").value.trim();

  if (!name) {
    showToast("error", "Please enter an employee name");
    return;
  }

  // Update employee name
  scheduleData.employees[editingEmployeeIndex].name = name;

  if (typeof window.refreshScheduleOutputs === "function") {
    try {
      await window.refreshScheduleOutputs({
        reason: "employee:update-name",
      });
    } catch (error) {
      console.error("Failed to refresh schedule after editing employee", error);
      renderSchedule();
      renderBreakTimeline();
      saveSchedule();
    }
  } else {
    renderSchedule();
    renderBreakTimeline();
    saveSchedule();
  }

  // Close modal
  document.getElementById("employeeEditModal").classList.add("hidden");

  // Show success message
  showToast("success", "Employee updated successfully");
}

// Open shift edit modal
function openShiftEditModal(index) {
  editingEmployeeIndex = index;

  const employee = scheduleData.employees[index];
  document.getElementById("shiftEditEmployee").textContent = employee.name;

  // Parse shift times
  const shiftParts = employee.shift.split("-");
  if (shiftParts.length === 2) {
    const startTime = parseTimeForInput(shiftParts[0].trim());
    const endTime = parseTimeForInput(shiftParts[1].trim());

    document.getElementById("shiftStartTime").value = startTime;
    document.getElementById("shiftEndTime").value = endTime;
  }

  document.getElementById("shiftEditModal").classList.remove("hidden");
}

// Save shift edit
async function saveShiftEdit() {
  const startTime = document.getElementById("shiftStartTime").value;
  const endTime = document.getElementById("shiftEndTime").value;

  if (!startTime || !endTime) {
    showToast("error", "Please enter both start and end times");
    return;
  }

  // Format times for display
  const startParts = startTime.split(":");
  const endParts = endTime.split(":");

  const startHour = parseInt(startParts[0]);
  const startMinute = parseInt(startParts[1]);
  const endHour = parseInt(endParts[0]);
  const endMinute = parseInt(endParts[1]);

  const formattedStartTime = formatTimeForDisplay(startHour, startMinute);
  const formattedEndTime = formatTimeForDisplay(endHour, endMinute);

  // Update shift
  const employee = scheduleData.employees[editingEmployeeIndex];
  employee.shift = `${formattedStartTime}-${formattedEndTime}`;
  if (!employee.hasManualBreaks) {
    employee.breaks = [];
    employee.break1 = "";
    employee.break1Duration = "";
    employee.lunch = "";
    employee.lunchDuration = "";
    employee.break2 = "";
    employee.break2Duration = "";
  }
  await window.recomputeBreaks();

  // Close modal
  document.getElementById("shiftEditModal").classList.add("hidden");

  // Show success message
  showToast("success", "Shift and breaks updated successfully");
}

// Open POS edit modal
function openPosEditModal(index) {
  editingEmployeeIndex = index;

  const employee = scheduleData.employees[index];
  document.getElementById("posEditEmployee").textContent = employee.name;
  document.getElementById("posNumber").value = employee.pos || "";

  document.getElementById("posEditModal").classList.remove("hidden");
  document.getElementById("posNumber").focus();
}

// Save POS edit
async function savePosEdit() {
  const posNumber = document.getElementById("posNumber").value.trim();

  // Update POS number
  scheduleData.employees[editingEmployeeIndex].pos = posNumber;

  if (typeof window.refreshScheduleOutputs === "function") {
    try {
      await window.refreshScheduleOutputs({
        reason: "employee:update-pos",
      });
    } catch (error) {
      console.error("Failed to refresh schedule after POS update", error);
      renderSchedule();
      saveSchedule();
    }
  } else {
    renderSchedule();
    saveSchedule();
  }

  // Close modal
  document.getElementById("posEditModal").classList.add("hidden");

  // Show success message
  showToast("success", "POS number updated successfully");
}

const BREAK_FIELD_CONFIG = [
  {
    type: "break1",
    timeId: "break1Time",
    skipId: "break1Skip",
    durationField: "break1Duration",
    durationControlId: null,
  },
  {
    type: "lunch",
    timeId: "lunchTime",
    skipId: "lunchSkip",
    durationField: "lunchDuration",
    durationControlId: "lunchDuration",
  },
  {
    type: "break2",
    timeId: "break2Time",
    skipId: "break2Skip",
    durationField: "break2Duration",
    durationControlId: null,
  },
];

function coerceCheckboxLikeValue(value) {
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

function findBreakEntry(breaks, index, type) {
  if (!Array.isArray(breaks)) {
    return null;
  }
  for (let i = 0; i < breaks.length; i += 1) {
    const candidate = breaks[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const candidateType =
      candidate.type || BREAK_FIELD_CONFIG[i]?.type || null;
    if (candidateType === type) {
      return candidate;
    }
  }
  return breaks[index] && typeof breaks[index] === "object"
    ? breaks[index]
    : null;
}

function readBreakSkip(entry, employee, type) {
  if (entry && typeof entry === "object") {
    if (coerceCheckboxLikeValue(entry.skip)) {
      return true;
    }
    if (coerceCheckboxLikeValue(entry.skipped)) {
      return true;
    }
  }
  const suffix = type.charAt(0).toUpperCase() + type.slice(1);
  return (
    coerceCheckboxLikeValue(employee?.[`${type}Skipped`]) ||
    coerceCheckboxLikeValue(employee?.[`${type}Skip`]) ||
    coerceCheckboxLikeValue(employee?.[`skip${suffix}`])
  );
}

function normalizeDurationValue(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }
  const text = String(value).trim();
  return text === "" ? fallback : text;
}

function setBreakFieldsDisabled(config, disabled) {
  const timeInput = document.getElementById(config.timeId);
  if (timeInput) {
    timeInput.disabled = disabled;
  }
  if (config.durationControlId) {
    const durationInput = document.getElementById(config.durationControlId);
    if (durationInput) {
      durationInput.disabled = disabled;
    }
  }
}

function applyBreakCheckboxListeners() {
  BREAK_FIELD_CONFIG.forEach((config) => {
    const checkbox = document.getElementById(config.skipId);
    if (!checkbox) {
      return;
    }
    checkbox.addEventListener("change", (event) => {
      setBreakFieldsDisabled(config, event.target.checked);
    });
  });
}

if (typeof document !== "undefined") {
  applyBreakCheckboxListeners();
}

// Open break edit modal
function openBreakEditModal(index) {
  editingEmployeeIndex = index;

  const employee = scheduleData.employees[index];
  document.getElementById("breakEditEmployee").textContent = employee.name;

  const breaks = Array.isArray(employee.breaks) ? employee.breaks : [];
  const policy = getBreakPolicy() || {};

  BREAK_FIELD_CONFIG.forEach((config, idx) => {
    const entry = findBreakEntry(breaks, idx, config.type) || {};
    const skip = readBreakSkip(entry, employee, config.type);
    const timeInput = document.getElementById(config.timeId);
    if (timeInput) {
      const sourceValue = skip
        ? ""
        : entry.start || employee[config.type] || "";
      timeInput.value = parseTimeForInput(sourceValue);
    }
    const checkbox = document.getElementById(config.skipId);
    if (checkbox) {
      checkbox.checked = skip;
    }
    if (config.durationControlId) {
      const durationInput = document.getElementById(config.durationControlId);
      if (durationInput) {
        const durationField = config.durationField;
        const durationSource =
          entry.duration ??
          employee[durationField] ??
          policy[durationField] ??
          "";
        durationInput.value = normalizeDurationValue(durationSource, "");
      }
    }
    setBreakFieldsDisabled(config, skip);
  });

  document.getElementById("breakEditModal").classList.remove("hidden");
}

// Save break edit
async function saveBreakEdit() {
  const break1Time = document.getElementById("break1Time").value;
  const lunchTime = document.getElementById("lunchTime").value;
  const lunchDuration = document.getElementById("lunchDuration").value;
  const break2Time = document.getElementById("break2Time").value;
  const break1Skipped = document.getElementById("break1Skip").checked;
  const lunchSkipped = document.getElementById("lunchSkip").checked;
  const break2Skipped = document.getElementById("break2Skip").checked;

  if (!break1Skipped && !break1Time) {
    showToast("error", "Please enter Break 1 time or mark it as skipped");
    return;
  }
  if (!lunchSkipped && !lunchTime) {
    showToast("error", "Please enter Lunch time or mark it as skipped");
    return;
  }
  if (!break2Skipped && !break2Time) {
    showToast("error", "Please enter Break 2 time or mark it as skipped");
    return;
  }
  if (!lunchSkipped && !lunchDuration) {
    showToast("error", "Please select a lunch duration or skip the lunch break");
    return;
  }

  // Format times for display
  const formatMaybeTime = (time) => {
    if (!time) {
      return "";
    }
    const parts = time.split(":");
    if (parts.length < 2) {
      return "";
    }
    return formatTimeForDisplay(parseInt(parts[0], 10), parseInt(parts[1], 10));
  };

  const formattedBreak1 = break1Skipped ? "" : formatMaybeTime(break1Time);
  const formattedLunch = lunchSkipped ? "" : formatMaybeTime(lunchTime);
  const formattedBreak2 = break2Skipped ? "" : formatMaybeTime(break2Time);

  // Update breaks
  const employee = scheduleData.employees[editingEmployeeIndex];
  const policy = getBreakPolicy() || {};
  const parseDuration = (value) => {
    const numeric = parseInt(value, 10);
    return Number.isNaN(numeric) || numeric <= 0 ? null : numeric;
  };
  const existingBreak1Dur = parseDuration(employee.break1Duration);
  const existingBreak2Dur = parseDuration(employee.break2Duration);
  const existingLunchDur = parseDuration(employee.lunchDuration);
  const policyBreak1Dur = parseDuration(policy.break1Duration);
  const policyBreak2Dur = parseDuration(policy.break2Duration);
  const policyLunchDur = parseDuration(policy.lunchDuration);
  const requestedLunchDur = parseDuration(lunchDuration);
  const break1DurationValue = break1Skipped
    ? null
    : existingBreak1Dur ?? policyBreak1Dur ?? 10;
  const break2DurationValue = break2Skipped
    ? null
    : existingBreak2Dur ?? policyBreak2Dur ?? 10;
  const lunchDurationValue = lunchSkipped
    ? null
    : requestedLunchDur ?? existingLunchDur ?? policyLunchDur ?? 30;

  employee.break1Skipped = break1Skipped;
  employee.lunchSkipped = lunchSkipped;
  employee.break2Skipped = break2Skipped;
  employee.break1 = break1Skipped ? "" : formattedBreak1;
  employee.break1Duration = break1Skipped
    ? ""
    : String(break1DurationValue ?? "");
  employee.lunch = lunchSkipped ? "" : formattedLunch;
  employee.lunchDuration = lunchSkipped
    ? ""
    : String(lunchDurationValue ?? "");
  employee.break2 = break2Skipped ? "" : formattedBreak2;
  employee.break2Duration = break2Skipped
    ? ""
    : String(break2DurationValue ?? "");
  employee.breaks = [
    break1Skipped
      ? { type: "break1", skip: true }
      : {
          start: formattedBreak1,
          duration: break1DurationValue ?? 0,
          type: "break1",
        },
    lunchSkipped
      ? { type: "lunch", skip: true }
      : {
          start: formattedLunch,
          duration: lunchDurationValue ?? 0,
          type: "lunch",
        },
    break2Skipped
      ? { type: "break2", skip: true }
      : {
          start: formattedBreak2,
          duration: break2DurationValue ?? 0,
          type: "break2",
        },
  ];
  employee.hasManualBreaks = true;

  // Update UI
  if (typeof window.refreshScheduleOutputs === "function") {
    await window.refreshScheduleOutputs();
  } else {
    if (typeof window.refreshChoreAssignments === "function") {
      await window.refreshChoreAssignments();
    }
    renderSchedule();
    renderBreakTimeline();
    saveSchedule();
  }

  // Close modal
  document.getElementById("breakEditModal").classList.add("hidden");

  // Show success message
  showToast("success", "Breaks updated successfully");
}

// Open clear schedule confirmation modal
function openClearScheduleModal() {
  document.getElementById("clearScheduleModal").classList.remove("hidden");
}

// Confirm clearing the schedule
function confirmClearSchedule() {
  const afterClear = () => {
    scheduleData.employees = [];
    const finish = () => {
      document.getElementById("clearScheduleModal").classList.add("hidden");
      showToast("success", "Schedule cleared successfully");
    };
    if (typeof window.refreshScheduleOutputs === "function") {
      window
        .refreshScheduleOutputs({ reason: "schedule:clear" })
        .then(finish)
        .catch((error) => {
          console.error("Failed to refresh schedule after clearing", error);
          renderSchedule();
          renderBreakTimeline();
          updateScheduleSummary();
          populateEmployeeSelector();
          saveSchedule();
          finish();
        });
    } else {
      renderSchedule();
      renderBreakTimeline();
      updateScheduleSummary();
      populateEmployeeSelector();
      saveSchedule();
      finish();
    }
  };

  if (currentStoreId > 0) {
    fetch(`api/clear.php?company_id=${COMPANY_ID}&store_id=${currentStoreId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=" + encodeURIComponent(API_TOKEN),
    }).then(afterClear);
  } else {
    afterClear();
  }
}

// Cancel clearing the schedule
function cancelClearSchedule() {
  document.getElementById("clearScheduleModal").classList.add("hidden");
}

// --- Import Schedule Modal ---
let pendingScheduleImport = null;

function openImportScheduleModal(schedule) {
  pendingScheduleImport = schedule;
  const container = document.getElementById("importScheduleList");
  container.replaceChildren();
  Object.keys(schedule).forEach((date) => {
    const label = document.createElement("label");
    label.className = "flex items-center space-x-2 mb-1";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "import-day-checkbox";
    cb.value = date;
    cb.checked = true;
    const span = document.createElement("span");
    span.textContent = parseDateKey(date).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  });
  document.getElementById("importScheduleModal").classList.remove("hidden");
}

function closeImportScheduleModal() {
  document.getElementById("importScheduleModal").classList.add("hidden");
  pendingScheduleImport = null;
}

async function confirmImportSchedule() {
  if (!pendingScheduleImport) return;

  // Gather selected dates
  const selected = Array.from(
    document.querySelectorAll(".import-day-checkbox:checked"),
  ).map((cb) => cb.value);

  if (selected.length === 0) {
    showToast("error", "Select at least one day");
    return;
  }

  // Merge selected days into scheduleMap
  selected.forEach((date) => {
    scheduleMap[date] = pendingScheduleImport[date];
  });

  // Sort and set currentDate using parseDateKey
  selected.sort();
  currentDate = parseDateKey(selected[0]);

  // Clean up and refresh UI
  pendingScheduleImport = null;
  document.getElementById("importScheduleModal").classList.add("hidden");
  switchToCurrentDate();
  updateDateDisplay();
  if (typeof window.refreshScheduleOutputs === "function") {
    try {
      await window.refreshScheduleOutputs({ reason: "schedule:import" });
    } catch (error) {
      console.error("Failed to refresh schedule after import", error);
      renderSchedule();
      renderBreakTimeline();
      updateScheduleSummary();
      populateEmployeeSelector();
      saveSchedule();
    }
  } else {
    renderSchedule();
    renderBreakTimeline();
    updateScheduleSummary();
    populateEmployeeSelector();
    saveSchedule();
  }
  showToast("success", "Schedule imported");
}

window.openEmployeeEditModal = openEmployeeEditModal;
window.saveEmployeeEdit = saveEmployeeEdit;
window.openShiftEditModal = openShiftEditModal;
window.saveShiftEdit = saveShiftEdit;
window.openPosEditModal = openPosEditModal;
window.savePosEdit = savePosEdit;
window.openBreakEditModal = openBreakEditModal;
window.saveBreakEdit = saveBreakEdit;
window.openClearScheduleModal = openClearScheduleModal;
window.confirmClearSchedule = confirmClearSchedule;
window.cancelClearSchedule = cancelClearSchedule;
window.openImportScheduleModal = openImportScheduleModal;
window.closeImportScheduleModal = closeImportScheduleModal;
window.confirmImportSchedule = confirmImportSchedule;
