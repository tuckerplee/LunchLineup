function fitCellText() {
  document
    .querySelectorAll(".schedule-table td, .tip-table td, .training-table td")
    .forEach((td) => {
      let size = parseFloat(getComputedStyle(td).fontSize);
      td.classList.add("small");
      while (
        (td.scrollHeight > td.clientHeight ||
          td.scrollWidth > td.clientWidth) &&
        size > 6
      ) {
        size -= 1;
        td.style.fontSize = size + "px";
      }
    });
}

// Debounce layout adjustments with rAF
let _raf;
function queueSnap() {
  cancelAnimationFrame(_raf);
  _raf = requestAnimationFrame(() => {
    padTrainingTable();
    fitCellText();
  });
}

function padTrainingTable() {
  const cardBody = document.querySelector(".training-card .card-body");
  const trainingTable = document.querySelector(".training-table");
  if (!cardBody || !trainingTable) return;
  const tbody = trainingTable.tBodies[0];
  const thead = trainingTable.tHead;
  if (!tbody || !thead) return;
  const rowPx =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--training-row-h",
      ),
    ) || 24;
  const bodyH = cardBody.getBoundingClientRect().height;
  const theadH = thead.getBoundingClientRect().height;
  const needed = Math.max(0, Math.ceil((bodyH - theadH) / rowPx));
  const diff = needed - tbody.rows.length;
  for (let i = 0; i < diff; i++) {
    const tr = document.createElement("tr");
    const td1 = document.createElement("td");
    td1.className = "text-break";
    const td2 = document.createElement("td");
    td2.className = "text-break";
    const td3 = document.createElement("td");
    td3.className = "text-break";
    tr.append(td1, td2, td3);
    tbody.appendChild(tr);
  }
}

window.addEventListener("resize", queueSnap);
window.addEventListener("orientationchange", queueSnap);
window.addEventListener("pageshow", queueSnap);
window.addEventListener("beforeprint", queueSnap);
window.addEventListener("load", queueSnap);