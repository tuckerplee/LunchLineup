function adminGoBack(status) {
  const params = new URLSearchParams();
  if (typeof COMPANY_ID !== "undefined") {
    params.set("company_id", COMPANY_ID);
  }
  if (status) {
    params.set("status", status);
  }
  const url = `company_dashboard.php?${params.toString()}`;
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "adminClose", url }, "*");
  } else if (typeof window.adminModalClose === "function") {
    window.adminModalClose(url);
  } else {
    window.location = url;
  }
}

function initAdminNav() {
  document
    .querySelectorAll('[data-action="cancel"], [data-action="back"]')
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        adminGoBack();
      });
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAdminNav);
} else {
  initAdminNav();
}