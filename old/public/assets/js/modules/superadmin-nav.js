function getCompanyId() {
  return typeof window.COMPANY_ID !== "undefined" ? window.COMPANY_ID : undefined;
}

function adminGoBack(status) {
  const params = new URLSearchParams();
  const companyId = getCompanyId();
  if (companyId) {
    params.set("company_id", companyId);
  }
  if (status) {
    params.set("status", status);
  }
  const url = `company_manage.php?${params.toString()}`;
  if (typeof openAdminModal === "function") {
    openAdminModal(url);
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
