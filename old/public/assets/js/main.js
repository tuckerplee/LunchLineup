// Load modules (state, utils, events, schedule, modals)
// Functions are declared globally in their respective files.

async function initApp() {
  const loaders = [loadEmployees(), loadSchedule(), loadChores()];
  if (typeof loadTemplates === "function") {
    loaders.push(loadTemplates());
  }
  await Promise.all(loaders);
  setupEventListeners();
  updateDateDisplay();
  const shouldForceBreaks =
    typeof scheduleNeedsAutoBreaks === "function"
      ? scheduleNeedsAutoBreaks()
      : false;
  if (typeof refreshScheduleOutputs === "function") {
    try {
      await refreshScheduleOutputs({
        reason: "app:init",
        forceBreakRecompute: shouldForceBreaks,
        skipSave: true,
      });
      return;
    } catch (error) {
      console.error("Failed to run initial schedule refresh", error);
    }
  }
  if (
    typeof recomputeBreaks === "function" &&
    shouldForceBreaks &&
    typeof refreshScheduleOutputs !== "function"
  ) {
    await recomputeBreaks();
  }
  renderSchedule();
  renderBreakTimeline();
  updateScheduleSummary();
  populateEmployeeSelector();
  renderGeneralTasks();
  updateRecyclingTaskVisibility();
}

document.addEventListener("DOMContentLoaded", initApp);
