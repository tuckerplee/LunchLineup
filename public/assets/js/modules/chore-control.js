window.ChoreControl = (() => {
  let config = { token: "", companyId: 0, storeId: 0 };
  let chores = [];
  let selectedKey = null;
  let tempCounter = 0;
  let saving = false;

  const htmlDecoder = document.createElement("textarea");

  let alertEl = null;
  let tableBody = null;
  let searchInput = null;
  let addBtn = null;
  let refreshBtn = null;
  let form = null;
  let saveBtn = null;
  let deleteBtn = null;
  let activeDayCheckboxes = [];
  let inputs = {};
  let abortController = null;
  let eventBindings = [];

  function cacheDom() {
    alertEl = document.getElementById("choreAlert");
    tableBody = document.getElementById("choreTableBody");
    searchInput = document.getElementById("choreSearch");
    addBtn = document.getElementById("addChore");
    refreshBtn = document.getElementById("refreshChores");
    form = document.getElementById("choreForm");
    saveBtn = document.getElementById("saveChore");
    deleteBtn = document.getElementById("deleteChore");
    activeDayCheckboxes = Array.from(
      document.querySelectorAll(".chore-active-day"),
    );
    inputs = {
      id: document.getElementById("choreId"),
      name: document.getElementById("choreName"),
      instructions: document.getElementById("choreInstructions"),
      priority: document.getElementById("chorePriority"),
      frequency: document.getElementById("choreFrequency"),
      interval: document.getElementById("choreInterval"),
      windowStart: document.getElementById("choreWindowStart"),
      windowEnd: document.getElementById("choreWindowEnd"),
      daypart: document.getElementById("choreDaypart"),
      deadline: document.getElementById("choreDeadline"),
      estimatedDuration: document.getElementById("choreEstimatedDuration"),
      assignedTo: document.getElementById("choreAssignedTo"),
      leadTime: document.getElementById("choreLeadTime"),
      minStaff: document.getElementById("choreMinStaff"),
      maxPerDay: document.getElementById("choreMaxPerDay"),
      maxPerShift: document.getElementById("choreMaxPerShift"),
      maxPerEmployee: document.getElementById("choreMaxPerEmployee"),
      isActive: document.getElementById("choreIsActive"),
      autoAssign: document.getElementById("choreAutoAssign"),
      allowMultiple: document.getElementById("choreAllowMultiple"),
      excludeCloser: document.getElementById("choreExcludeCloser"),
      excludeOpener: document.getElementById("choreExcludeOpener"),
    };
  }

  function resetState() {
    chores = [];
    selectedKey = null;
    tempCounter = 0;
    saving = false;
  }

  function teardownEvents() {
    if (abortController) {
      abortController.abort();
    }
    abortController = null;
    if (eventBindings.length > 0) {
      eventBindings.forEach(({ element, type, handler }) => {
        element.removeEventListener(type, handler);
      });
      eventBindings = [];
    }
  }

  function apiUrl() {
    const params = new URLSearchParams({
      token: config.token,
      company_id: String(config.companyId),
      store_id: String(config.storeId),
    });
    return `../api/chores.php?${params.toString()}`;
  }

  function showAlert(type, message) {
    if (!alertEl) return;
    alertEl.className = `alert alert-${type}`;
    alertEl.textContent = message;
    alertEl.classList.remove("d-none");
  }

  function hideAlert() {
    if (!alertEl) return;
    alertEl.classList.add("d-none");
  }

  function decodeHtml(value) {
    if (typeof value !== "string") {
      return typeof value === "undefined" || value === null ? "" : String(value);
    }
    htmlDecoder.innerHTML = value;
    return htmlDecoder.value;
  }

  function sanitizeList(value) {
    if (Array.isArray(value)) {
      return value
        .map((entry) => decodeHtml(String(entry || "")))
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    }
    if (typeof value === "string") {
      return decodeHtml(value)
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    }
    return [];
  }

  function parseDays(value) {
    const valid = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
    return sanitizeList(value).filter((day) => valid.has(day));
  }

  function parseBoolean(value) {
    return value === true || value === 1 || value === "1" || value === "true";
  }

  function parseIntOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function parseTime(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d{2}:\d{2}$/.test(trimmed)) {
      return `${trimmed}:00`;
    }
    if (/^\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  function normalizeChore(chore) {
    const key = `chore-${String(chore.id ?? `new-${tempCounter++}`)}`;
    const activeDays = parseDays(chore.activeDays);
    return {
      id: chore.id != null ? Number(chore.id) : null,
      clientKey: key,
      name: decodeHtml(chore.name ?? chore.description ?? ""),
      description: decodeHtml(chore.description ?? chore.name ?? ""),
      instructions: decodeHtml(chore.instructions ?? ""),
      priority: parseInt(chore.priority, 10) || 0,
      frequency: chore.frequency ?? "daily",
      recurrenceInterval: parseInt(chore.recurrenceInterval, 10) || 1,
      activeDays,
      windowStart: chore.windowStart ?? null,
      windowEnd: chore.windowEnd ?? null,
      daypart: chore.daypart ?? null,
      deadlineTime: chore.deadlineTime ?? null,
      leadTimeMinutes: parseIntOrNull(chore.leadTimeMinutes),
      estimatedDurationMinutes: parseIntOrNull(
        chore.estimatedDurationMinutes,
      ),
      assignedTo:
        chore.assignedTo != null ? Number(chore.assignedTo) : null,
      maxPerDay: parseIntOrNull(chore.maxPerDay),
      maxPerShift: parseIntOrNull(chore.maxPerShift),
      maxPerEmployeePerDay: parseIntOrNull(chore.maxPerEmployeePerDay),
      minStaffLevel: parseIntOrNull(chore.minStaffLevel),
      isActive: parseBoolean(chore.isActive ?? true),
      autoAssignEnabled: parseBoolean(chore.autoAssignEnabled ?? true),
      allowMultipleAssignees: parseBoolean(
        chore.allowMultipleAssignees ?? false,
      ),
      excludeCloser: parseBoolean(chore.excludeCloser ?? false),
      excludeOpener: parseBoolean(chore.excludeOpener ?? false),
    };
  }

  function resetForm() {
    if (form) {
      form.reset();
    }
    if (inputs.id) {
      inputs.id.value = "";
    }
    activeDayCheckboxes.forEach((checkbox) => {
      checkbox.checked = false;
    });
    selectedKey = null;
  }

  function fillForm(chore) {
    if (!inputs || Object.keys(inputs).length === 0) {
      return;
    }
    inputs.id.value = chore.id ?? "";
    inputs.name.value = chore.name ?? "";
    inputs.instructions.value = chore.instructions ?? "";
    inputs.priority.value = chore.priority ?? 0;
    inputs.frequency.value = chore.frequency ?? "daily";
    inputs.interval.value = chore.recurrenceInterval ?? 1;
    inputs.windowStart.value =
      chore.windowStart ? chore.windowStart.slice(0, 5) : "";
    inputs.windowEnd.value =
      chore.windowEnd ? chore.windowEnd.slice(0, 5) : "";
    inputs.daypart.value = chore.daypart ?? "";
    inputs.deadline.value =
      chore.deadlineTime ? chore.deadlineTime.slice(0, 5) : "";
    inputs.estimatedDuration.value =
      chore.estimatedDurationMinutes ?? "";
    inputs.assignedTo.value = chore.assignedTo ?? "";
    inputs.leadTime.value = chore.leadTimeMinutes ?? "";
    inputs.minStaff.value = chore.minStaffLevel ?? "";
    inputs.maxPerDay.value = chore.maxPerDay ?? "";
    inputs.maxPerShift.value = chore.maxPerShift ?? "";
    inputs.maxPerEmployee.value = chore.maxPerEmployeePerDay ?? "";
    inputs.isActive.checked = chore.isActive;
    inputs.autoAssign.checked = chore.autoAssignEnabled;
    inputs.allowMultiple.checked = chore.allowMultipleAssignees;
    inputs.excludeCloser.checked = chore.excludeCloser;
    inputs.excludeOpener.checked = chore.excludeOpener;
    activeDayCheckboxes.forEach((checkbox) => {
      checkbox.checked = chore.activeDays.includes(checkbox.value);
    });
  }

  function getSelectedChore() {
    if (!selectedKey) return null;
    return chores.find((c) => c.clientKey === selectedKey) ?? null;
  }

  function gatherFormData() {
    if (!inputs || Object.keys(inputs).length === 0) {
      return null;
    }
    const name = inputs.name.value.trim();
    const instructions = inputs.instructions.value.trim();
    const activeDays = activeDayCheckboxes
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value);

    const chore = getSelectedChore() ?? {
      id: null,
      clientKey: selectedKey ?? `new-${Date.now()}-${tempCounter++}`,
    };

    return {
      ...chore,
      name,
      description: name,
      instructions,
      priority: parseInt(inputs.priority.value, 10) || 0,
      frequency: inputs.frequency.value,
      recurrenceInterval: parseInt(inputs.interval.value, 10) || 1,
      activeDays,
      windowStart: inputs.windowStart.value || null,
      windowEnd: inputs.windowEnd.value || null,
      daypart: inputs.daypart.value || null,
      deadlineTime: inputs.deadline.value || null,
      estimatedDurationMinutes: parseIntOrNull(
        inputs.estimatedDuration.value,
      ),
      assignedTo: parseIntOrNull(inputs.assignedTo.value),
      leadTimeMinutes: parseIntOrNull(inputs.leadTime.value),
      minStaffLevel: parseIntOrNull(inputs.minStaff.value),
      maxPerDay: parseIntOrNull(inputs.maxPerDay.value),
      maxPerShift: parseIntOrNull(inputs.maxPerShift.value),
      maxPerEmployeePerDay: parseIntOrNull(inputs.maxPerEmployee.value),
      isActive: inputs.isActive.checked,
      autoAssignEnabled: inputs.autoAssign.checked,
      allowMultipleAssignees: inputs.allowMultiple.checked,
      excludeCloser: inputs.excludeCloser.checked,
      excludeOpener: inputs.excludeOpener.checked,
    };
  }

  function renderList() {
    if (!tableBody) return;
    tableBody.replaceChildren();
    const query = searchInput?.value.trim().toLowerCase() ?? "";
    const filtered = chores.filter((chore) => {
      if (query === "") return true;
      return (
        chore.name.toLowerCase().includes(query) ||
        (chore.instructions ?? "").toLowerCase().includes(query)
      );
    });
    if (filtered.length === 0) {
      const emptyRow = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 2;
      cell.className = "text-center text-muted";
      cell.textContent = "No chores found.";
      emptyRow.appendChild(cell);
      tableBody.appendChild(emptyRow);
      return;
    }
    filtered.forEach((chore) => {
      const row = document.createElement("tr");
      row.dataset.key = chore.clientKey;
      if (chore.clientKey === selectedKey) {
        row.classList.add("table-active");
      }
      const nameCell = document.createElement("td");
      nameCell.textContent = chore.name || "(Untitled)";
      const priorityCell = document.createElement("td");
      priorityCell.className = "text-end";
      priorityCell.textContent = String(chore.priority ?? 0);
      row.appendChild(nameCell);
      row.appendChild(priorityCell);
      row.addEventListener("click", () => {
        selectedKey = chore.clientKey;
        fillForm(chore);
        renderList();
      });
      tableBody.appendChild(row);
    });
  }

  function preparePayload() {
    return chores.map((chore) => {
      const payload = { ...chore };
      delete payload.clientKey;
      payload.id = payload.id != null && payload.id > 0 ? payload.id : null;
      payload.description = payload.name;
      payload.activeDays = payload.activeDays;
      payload.windowStart = payload.windowStart
        ? parseTime(payload.windowStart)
        : null;
      payload.windowEnd = payload.windowEnd ? parseTime(payload.windowEnd) : null;
      payload.deadlineTime = payload.deadlineTime
        ? parseTime(payload.deadlineTime)
        : null;
      payload.allowMultipleAssignees = !!payload.allowMultipleAssignees;
      payload.autoAssignEnabled = !!payload.autoAssignEnabled;
      payload.excludeCloser = !!payload.excludeCloser;
      payload.excludeOpener = !!payload.excludeOpener;
      payload.isActive = !!payload.isActive;
      return payload;
    });
  }

  function syncChores() {
    if (saving) return;
    saving = true;
    if (saveBtn) {
      saveBtn.disabled = true;
    }
    if (deleteBtn) {
      deleteBtn.disabled = true;
    }
    const payload = preparePayload();
    fetch(apiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to save chores");
        }
        return response.json().catch(() => ({}));
      })
      .then(() => {
        showAlert("success", "Chores saved successfully.");
        return loadChores(false);
      })
      .catch((error) => {
        console.error(error);
        showAlert("danger", "Unable to save chores. Please try again.");
      })
      .finally(() => {
        saving = false;
        if (saveBtn) {
          saveBtn.disabled = false;
        }
        if (deleteBtn) {
          deleteBtn.disabled = false;
        }
      });
  }

  function loadChores(showMessage = true) {
    hideAlert();
    return fetch(apiUrl())
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to load chores");
        }
        return response.json();
      })
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        chores = list.map((item) => normalizeChore(item));
        if (chores.length > 0) {
          selectedKey = chores[0].clientKey;
          fillForm(chores[0]);
        } else {
          resetForm();
        }
        renderList();
        if (showMessage) {
          showAlert("info", "Chore templates loaded.");
        }
      })
      .catch((error) => {
        console.error(error);
        chores = [];
        resetForm();
        renderList();
        showAlert("danger", "Unable to load chores for this store.");
      });
  }

  function handleSave(event) {
    event.preventDefault();
    if (!inputs || Object.keys(inputs).length === 0) {
      return;
    }
    const name = inputs.name.value.trim();
    if (name === "") {
      showAlert("warning", "Name is required.");
      inputs.name.focus();
      return;
    }
    const updated = gatherFormData();
    if (!updated) {
      showAlert("danger", "Unable to read form data. Please retry.");
      return;
    }
    const existingIndex = chores.findIndex(
      (chore) => chore.clientKey === updated.clientKey,
    );
    if (existingIndex === -1) {
      chores.push(updated);
    } else {
      chores[existingIndex] = updated;
    }
    selectedKey = updated.clientKey;
    renderList();
    syncChores();
  }

  function handleDelete() {
    const current = getSelectedChore();
    if (!current) {
      showAlert("warning", "Select a template before deleting.");
      return;
    }
    if (!window.confirm("Delete this chore template?")) {
      return;
    }
    chores = chores.filter((chore) => chore.clientKey !== current.clientKey);
    resetForm();
    renderList();
    syncChores();
  }

  function handleAdd() {
    hideAlert();
    const key = `new-${Date.now()}-${tempCounter++}`;
    const newChore = normalizeChore({
      id: null,
      name: "",
      description: "",
      priority: 0,
      frequency: "daily",
      recurrenceInterval: 1,
      activeDays: [],
      autoAssignEnabled: true,
      isActive: true,
    });
    newChore.clientKey = key;
    newChore.id = null;
    chores.push(newChore);
    selectedKey = key;
    fillForm(newChore);
    renderList();
  }

  function bindEvents() {
    teardownEvents();
    abortController =
      typeof AbortController === "function" ? new AbortController() : null;
    const signal = abortController?.signal;
    const listenerOptions = signal ? { signal } : undefined;

    const register = (element, type, handler) => {
      if (!element) return;
      element.addEventListener(type, handler, listenerOptions);
      eventBindings.push({ element, type, handler });
    };

    register(searchInput, "input", () => {
      renderList();
    });
    register(addBtn, "click", handleAdd);
    register(refreshBtn, "click", () => {
      loadChores();
    });
    register(form, "submit", handleSave);
    register(deleteBtn, "click", handleDelete);
  }

  function init(options) {
    cacheDom();
    resetState();
    hideAlert();
    config = {
      token: options.token ?? "",
      companyId: Number(options.companyId ?? 0),
      storeId: Number(options.storeId ?? 0),
    };
    bindEvents();
    loadChores();
  }

  function destroy() {
    teardownEvents();
    resetState();
    config = { token: "", companyId: 0, storeId: 0 };
    alertEl = null;
    tableBody = null;
    searchInput = null;
    addBtn = null;
    refreshBtn = null;
    form = null;
    saveBtn = null;
    deleteBtn = null;
    activeDayCheckboxes = [];
    inputs = {};
  }

  return { init, destroy };
})();
