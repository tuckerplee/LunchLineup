let datePicker;

// Setup event listeners
function setupEventListeners() {
  const dateDisplay = document.getElementById("currentDateDisplay");
  const storeSelector = document.getElementById("storeSelector");
  if (storeSelector) {
    storeSelector.addEventListener("change", (e) => {
      const id = parseInt(e.target.value, 10);
      if (!Number.isNaN(id)) {
        const params = new URLSearchParams();
        params.set("company_id", String(COMPANY_ID));
        params.set("store_id", String(id));
        const dateKey = getCurrentDateKey();
        if (dateKey) {
          params.set("date", dateKey);
        }
        const query = params.toString();
        window.location.href = query ? `app.php?${query}` : "app.php";
      }
    });
  }
  if (dateDisplay) {
    datePicker = flatpickr(dateDisplay, {
      defaultDate: currentDate,
      disableMobile: true,
      onChange: async (selectedDates) => {
        currentDate = selectedDates[0];
        updateDateDisplay();
        updateRecyclingTaskVisibility();
        switchToCurrentDate();
        await refreshScheduleOutputs({
          reason: "date:picker",
          skipSave: true,
        });
      },
    });

    updateDateDisplay();
  }
  // Date navigation
  document.getElementById("prevDate").addEventListener("click", async () => {
    currentDate.setDate(currentDate.getDate() - 1);
    if (datePicker) datePicker.setDate(currentDate, true);
    updateDateDisplay();
    updateRecyclingTaskVisibility();
    switchToCurrentDate();
    await refreshScheduleOutputs({ reason: "date:prev", skipSave: true });
  });

  document.getElementById("nextDate").addEventListener("click", async () => {
    currentDate.setDate(currentDate.getDate() + 1);
    if (datePicker) datePicker.setDate(currentDate, true);
    updateDateDisplay();
    updateRecyclingTaskVisibility();
    switchToCurrentDate();
    await refreshScheduleOutputs({ reason: "date:next", skipSave: true });
  });

  // Detect if the day has changed when refocusing the window
    window.addEventListener("focus", checkForDateChange);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkForDateChange();
    });
    window.addEventListener("beforeunload", saveSchedule);

    // Print button - open server-rendered schedule if data exists
    document.getElementById("printButton").addEventListener("click", () => {
      if (!scheduleData.employees || scheduleData.employees.length === 0) {
        showToast("error", "No schedule to print");
        return;
      }

      const params = new URLSearchParams({
        token: API_TOKEN,
        company_id: String(COMPANY_ID),
        store_id: String(currentStoreId),
        date: getCurrentDateKey(),
      });

      window.open(`print_pdf.php?${params.toString()}`, "_blank");
    });

  // Import schedule from PDF
  const importInput = document.getElementById("importPdfInput");
  document
    .getElementById("importButton")
    .addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", handlePdfUpload);

  // Other header buttons
  document
    .getElementById("clearButton")
    .addEventListener("click", () => openClearScheduleModal());

  // Add employee button
  document
    .getElementById("addEmployee")
    .addEventListener("click", () => addEmployee());

  // Employee edit modal buttons
  document
    .getElementById("cancelEmployeeEdit")
    .addEventListener("click", () => {
      document.getElementById("employeeEditModal").classList.add("hidden");
    });

  document
    .getElementById("saveEmployeeEdit")
    .addEventListener("click", saveEmployeeEdit);

  // Shift edit modal buttons
  document.getElementById("cancelShiftEdit").addEventListener("click", () => {
    document.getElementById("shiftEditModal").classList.add("hidden");
  });

  document
    .getElementById("saveShiftEdit")
    .addEventListener("click", saveShiftEdit);

  // POS edit modal buttons
  document.getElementById("cancelPosEdit").addEventListener("click", () => {
    document.getElementById("posEditModal").classList.add("hidden");
  });

  document.getElementById("savePosEdit").addEventListener("click", savePosEdit);

  // Break edit modal buttons
  document.getElementById("cancelBreakEdit").addEventListener("click", () => {
    document.getElementById("breakEditModal").classList.add("hidden");
  });

  document
    .getElementById("saveBreakEdit")
    .addEventListener("click", saveBreakEdit);

  // Clear schedule modal buttons (if modal exists)
  const confirmBtn = document.getElementById("confirmClearSchedule");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", confirmClearSchedule);
  }
  const cancelBtn = document.getElementById("cancelClearSchedule");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", cancelClearSchedule);
  }

  // Import schedule modal buttons
  const confirmImport = document.getElementById("confirmImportSchedule");
  if (confirmImport) {
    confirmImport.addEventListener("click", confirmImportSchedule);
  }
  const cancelImport = document.getElementById("cancelImportSchedule");
  if (cancelImport) {
    cancelImport.addEventListener("click", closeImportScheduleModal);
  }

  // Schedule table event delegation
  scheduleBody.addEventListener("click", (e) => {
    // Delete employee
    if (e.target.closest(".delete-employee")) {
      const index = parseInt(
        e.target.closest(".delete-employee").getAttribute("data-index"),
      );
      const employeeId = parseInt(
        e.target.closest(".delete-employee").getAttribute("data-employee-id"),
      );
      deleteEmployee(employeeId, index);
    }

    // Edit employee
    if (e.target.closest(".employee-edit-btn")) {
      const index = parseInt(
        e.target.closest(".employee-edit-btn").getAttribute("data-index"),
      );
      openEmployeeEditModal(index);
    }

    // Edit shift
    if (e.target.closest(".shift-edit-btn")) {
      const index = parseInt(
        e.target.closest(".shift-edit-btn").getAttribute("data-index"),
      );
      openShiftEditModal(index);
    }

    // Edit POS
    if (e.target.closest(".pos-edit-btn")) {
      const index = parseInt(
        e.target.closest(".pos-edit-btn").getAttribute("data-index"),
      );
      openPosEditModal(index);
    }

    // Edit break
    if (e.target.closest(".break-edit-btn")) {
      const index = parseInt(
        e.target.closest(".break-edit-btn").getAttribute("data-index"),
      );
      openBreakEditModal(index);
    }

    // Employee name dropdown
    if (e.target.closest(".employee-name")) {
      const index = parseInt(
        e.target.closest(".employee-name").getAttribute("data-index"),
      );
      toggleEmployeeNameDropdown(index, e.target.closest(".employee-name"));
    }
  });

  // Close employee name dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (
      !e.target.closest(".employee-name") &&
      !e.target.closest(".employee-name-dropdown")
    ) {
      employeeNameDropdown.classList.remove("show");
      activeEmployeeDropdown = null;
    }
  });

  // Employee name dropdown event delegation
  employeeNameDropdown.addEventListener("click", (e) => {
    if (e.target.closest(".employee-option")) {
      const employeeId = parseInt(
        e.target.closest(".employee-option").getAttribute("data-employee-id"),
      );
      const index = activeEmployeeDropdown;

      if (index !== null) {
        changeEmployee(index, employeeId);
        employeeNameDropdown.classList.remove("show");
        activeEmployeeDropdown = null;
      }
    }
  });
}

// Upload PDF and import the resulting schedule
function handlePdfUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append("pdf", file);

  fetch(
    "api/import_pdf.php?token=" +
      encodeURIComponent(API_TOKEN) +
      "&company_id=" +
      COMPANY_ID +
      "&store_id=" +
      currentStoreId,
    {
      method: "POST",
      body: formData,
    }
  )
    .then((r) => r.json())
    .then((data) => {
      console.log("import result", data);
      if (data && data.schedule) {
        openImportScheduleModal(data.schedule);
      } else {
        showToast("error", "Could not parse schedule");
      }
    })
    .catch((err) => {
      console.error(err);
      showToast("error", "Failed to import PDF");
    })
    .finally(() => {
      e.target.value = "";
    });
}
