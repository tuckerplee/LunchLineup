export function initDashboard({ token, companyId, storePageSize, userPageSize }) {
  const TOKEN = token;
  const COMPANY_ID = companyId;
  const STORE_PAGE_SIZE = storePageSize;
  let storePage = 1;
  const USER_PAGE_SIZE = userPageSize;
  let userPage = 1;
  let metricsChart;
  let deleteId = null;
  let deleteType = "";
  let confirmModal;
  let actionModal;
  const actionBody = document.getElementById("actionBody");

  function openAction(url, title) {
    document.getElementById("actionModalLabel").textContent = title;
    fetch(url)
      .then(r => r.text())
      .then(html => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        actionBody.innerHTML = doc.body.innerHTML;
        const scripts = Array.from(doc.querySelectorAll("script"));
        (function load(i) {
          if (i === scripts.length) {
            if (!actionModal) {
              actionModal = new bootstrap.Modal(document.getElementById("actionModal"));
            }
            actionModal.show();
            return;
          }
          const old = scripts[i];
          const s = document.createElement("script");
          if (old.src) {
            s.src = old.src;
            s.onload = () => load(i + 1);
            actionBody.appendChild(s);
          } else {
            s.textContent = old.textContent;
            actionBody.appendChild(s);
            load(i + 1);
          }
        })(0);
      });
  }
  window.openAdminModal = openAction;

  function attachActionHandlers() {
    document.querySelectorAll(".action-link").forEach(el => {
      if (el.dataset.bound === "1") {
        return;
      }
      el.dataset.bound = "1";
      el.addEventListener("click", e => {
        e.preventDefault();
        const url = el.getAttribute("data-url");
        const title = el.getAttribute("data-title");
        openAction(url, title);
      });
    });
  }

  attachActionHandlers();
  document.querySelectorAll(".card-open").forEach(btn => {
    btn.addEventListener("click", () => {
      openAction(btn.dataset.link, btn.dataset.title);
    });
  });
  window.adminModalClose = url => {
    if (actionModal) {
      actionModal.hide();
    }
    if (url) {
      window.location.href = url;
    }
  };
  document.getElementById("actionModal").addEventListener("hidden.bs.modal", () => {
    actionBody.innerHTML = "";
  });

  function attachDeletes() {
    document.querySelectorAll("button[data-id]").forEach(btn => {
      btn.addEventListener("click", e => {
        deleteId = e.target.getAttribute("data-id");
        deleteType = e.target.getAttribute("data-type");
        document.getElementById("confirmItemType").textContent = deleteType;
        if (!confirmModal) {
          confirmModal = new bootstrap.Modal(document.getElementById("confirmModal"));
        }
        confirmModal.show();
      });
    });
  }

  document.getElementById("confirmDeleteBtn").addEventListener("click", () => {
    const url =
      deleteType === "store"
        ? `../api/stores.php?id=${deleteId}&token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`
        : `../api/users.php?id=${deleteId}&token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`;
    fetch(url, { method: "DELETE" }).then(() => {
      confirmModal.hide();
      if (deleteType === "store") {
        loadStores();
      } else {
        loadUsers();
      }
    });
  });

  function loadStores() {
    const search = document.getElementById("storeSearch").value;
    const url = `../api/stores.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}&search=${encodeURIComponent(search)}&page=${storePage}`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const tbody = document.querySelector("#storeTable tbody");
        tbody.replaceChildren();
        data.forEach(store => {
          const tr = document.createElement("tr");

          const idTd = document.createElement("td");
          idTd.textContent = store.id;
          tr.appendChild(idTd);

          const nameTd = document.createElement("td");
          nameTd.textContent = store.name;
          tr.appendChild(nameTd);

          const locTd = document.createElement("td");
          locTd.textContent = store.location || "";
          tr.appendChild(locTd);

          const actionsTd = document.createElement("td");
          const editLink = document.createElement("a");
          editLink.className = "btn btn-sm btn-secondary action-link";
          editLink.href = "#";
          editLink.setAttribute("data-url", `store.php?id=${store.id}&company_id=${COMPANY_ID}`);
          editLink.setAttribute("data-title", "Edit Store");
          editLink.textContent = "Edit";
          actionsTd.appendChild(editLink);

          const delBtn = document.createElement("button");
          delBtn.className = "btn btn-sm btn-danger ms-2";
          delBtn.setAttribute("data-id", store.id);
          delBtn.setAttribute("data-type", "store");
          delBtn.textContent = "Delete";
          actionsTd.appendChild(delBtn);

          tr.appendChild(actionsTd);

          tbody.appendChild(tr);
        });
        document.getElementById("prevStore").disabled = storePage === 1;
        document.getElementById("nextStore").disabled = data.length < STORE_PAGE_SIZE;
        attachDeletes();
        attachActionHandlers();
      });
  }

  function loadUsers() {
    const search = document.getElementById("userSearch").value;
    const url = `../api/users.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}&admins=false&search=${encodeURIComponent(search)}&page=${userPage}`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const tbody = document.querySelector("#userTable tbody");
        tbody.replaceChildren();
        data.forEach(user => {
          const tr = document.createElement("tr");

          const idTd = document.createElement("td");
          idTd.textContent = user.id;
          tr.appendChild(idTd);

          const usernameTd = document.createElement("td");
          usernameTd.textContent = user.username;
          tr.appendChild(usernameTd);

          const homeTd = document.createElement("td");
          homeTd.textContent = user.homeStoreId;
          tr.appendChild(homeTd);

          const adminTd = document.createElement("td");
          adminTd.textContent = user.isAdmin ? "Yes" : "No";
          tr.appendChild(adminTd);

          const actionsTd = document.createElement("td");
          const editLink = document.createElement("a");
          editLink.className = "btn btn-sm btn-secondary action-link";
          editLink.href = "#";
          editLink.setAttribute("data-url", `user.php?id=${user.id}&company_id=${COMPANY_ID}`);
          editLink.setAttribute("data-title", "Edit User");
          editLink.textContent = "Edit";
          actionsTd.appendChild(editLink);

          const delBtn = document.createElement("button");
          delBtn.className = "btn btn-sm btn-danger ms-2";
          delBtn.setAttribute("data-id", user.id);
          delBtn.setAttribute("data-type", "user");
          delBtn.textContent = "Delete";
          actionsTd.appendChild(delBtn);

          tr.appendChild(actionsTd);

          tbody.appendChild(tr);
        });
        document.getElementById("prevUser").disabled = userPage === 1;
        document.getElementById("nextUser").disabled = data.length < USER_PAGE_SIZE;
        attachDeletes();
        attachActionHandlers();
      });
  }

  function loadMetrics() {
    const timeframe = document.getElementById("timeframe").value;
    const url = `../admin-api/metrics.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}&timeframe=${timeframe}`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const labels = data.shifts.map(s => s.week);
        const values = data.shifts.map(s => Number(s.total));
        if (metricsChart) {
          metricsChart.data.labels = labels;
          metricsChart.data.datasets[0].data = values;
          metricsChart.update();
        } else {
          const ctx = document.getElementById("metricsChart").getContext("2d");
          metricsChart = new Chart(ctx, {
            type: "bar",
            data: {
              labels,
              datasets: [
                {
                  label: "Shifts",
                  data: values,
                  backgroundColor: "rgba(54, 162, 235, 0.5)",
                },
              ],
            },
          });
        }
        document.getElementById("pendingChores").textContent = data.pendingChores;
      });
  }

  document.getElementById("storeSearch").addEventListener("input", () => {
    storePage = 1;
    loadStores();
  });
  document.getElementById("prevStore").addEventListener("click", () => {
    if (storePage > 1) {
      storePage--;
      loadStores();
    }
  });
  document.getElementById("nextStore").addEventListener("click", () => {
    storePage++;
    loadStores();
  });
  document.getElementById("userSearch").addEventListener("input", () => {
    userPage = 1;
    loadUsers();
  });
  document.getElementById("prevUser").addEventListener("click", () => {
    if (userPage > 1) {
      userPage--;
      loadUsers();
    }
  });
  document.getElementById("nextUser").addEventListener("click", () => {
    userPage++;
    loadUsers();
  });

  document.getElementById("timeframe").addEventListener("change", loadMetrics);

  loadStores();
  loadUsers();
  loadMetrics();

  document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
    new bootstrap.Tooltip(el);
  });
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!prefersReduced) {
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add("animate-in");
            observer.unobserve(entry.target);
          }
        });
      });
      document.querySelectorAll(".dashboard-card").forEach(card => observer.observe(card));
    } else {
      document.querySelectorAll(".dashboard-card").forEach(card => card.classList.add("animate-in"));
    }
  }
}
