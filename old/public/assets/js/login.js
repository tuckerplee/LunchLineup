document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");
  const loginView = document.getElementById("loginView");
  const registerView = document.getElementById("registerView");

  if (!loginForm || !registerForm || !loginView || !registerView) {
    return;
  }

  document.getElementById("showRegister")?.addEventListener("click", (e) => {
    e.preventDefault();
    loginView.classList.remove("active");
    registerView.classList.add("active");
    registerForm.querySelector("input")?.focus();
    window.location.hash = "register";
  });
  document.getElementById("showLogin")?.addEventListener("click", (e) => {
    e.preventDefault();
    registerView.classList.remove("active");
    loginView.classList.add("active");
    loginForm.querySelector("input")?.focus();
    window.location.hash = "login";
  });
  if (window.location.hash === "#register") {
    loginView.classList.remove("active");
    registerView.classList.add("active");
    registerForm.querySelector("input")?.focus();
  } else {
    loginForm.querySelector("input")?.focus();
  }
  loginForm.addEventListener("submit", handleLogin);
  registerForm.addEventListener("submit", handleRegister);
});

async function handleLogin(e) {
  e.preventDefault();
  const form = document.getElementById("loginForm");
  if (!form) {
    return;
  }
  const usernameInput =
    form.querySelector("input[name='username']") ||
    form.querySelector("#username") ||
    document.getElementById("email");
  const passwordInput =
    form.querySelector("input[name='password']") ||
    form.querySelector("#password");
  if (!usernameInput || !passwordInput) {
    alert(
      "Login form is missing required fields. Please refresh and try again."
    );
    return;
  }
  const btn = form.querySelector("button[type='submit']");
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML =
    '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Logging in...';
  try {
    const res = await fetch("api/auth.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value.trim(),
      }),
    });
    const data = await res.json();
    if (data.token) {
      const companies = data.companies || [];
      if (data.isSuperAdmin) {
        window.location.href = "admin/index.php";
        return;
      }
      if (companies.length > 1) {
        showCompanySelector(companies, !!data.isCompanyAdmin);
        return;
      }
      const companyId =
        data.companyId ||
        (companies[0]
          ? typeof companies[0] === "object"
            ? companies[0].id
            : companies[0]
          : null);
      if (data.isCompanyAdmin && companyId) {
        window.location.href = "admin/index.php?company_id=" + companyId;
      } else if (companyId) {
        window.location.href = "app.php?company_id=" + companyId;
      } else {
        window.location.href = "app.php";
      }
    } else {
      alert("Login failed");
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

function handleRegister(e) {
  e.preventDefault();
  const form = document.getElementById("registerForm");
  const btn = form.querySelector("button[type='submit']");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Invalid Invite Code";
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = originalText;
  }, 2000);
}

function showCompanySelector(companies, isCompanyAdmin) {
  const formWrapper = document.querySelector(".auth-form > div");
  formWrapper.innerHTML = `
        <h2 class="mb-3">Select Company</h2>
        <div class="mb-3">
            <label for="companySelect" class="form-label">Company</label>
            <select id="companySelect" class="form-select"></select>
        </div>
        <button id="companyContinue" class="btn btn-primary w-100">Continue</button>
    `;
  const select = document.getElementById("companySelect");
  companies.forEach((c) => {
    const id = typeof c === "object" ? c.id : c;
    const name = typeof c === "object" && c.name ? c.name : "Company " + id;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    select.appendChild(opt);
  });
  document.getElementById("companyContinue").addEventListener("click", () => {
    const cid = select.value;
    if (isCompanyAdmin) {
      window.location.href = "admin/index.php?company_id=" + cid;
    } else {
      window.location.href = "app.php?company_id=" + cid;
    }
  });
}
