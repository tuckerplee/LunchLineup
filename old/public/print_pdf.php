<?php
declare(strict_types=1);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Schedule PDF</title>
    <style>
        :root {
            color-scheme: light dark;
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            display: flex;
            min-height: 100vh;
        }

        main.viewer {
            margin: auto;
            width: min(960px, 100vw);
            height: min(90vh, 960px);
            background: rgba(15, 23, 42, 0.6);
            backdrop-filter: blur(18px);
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 20px;
            box-shadow: 0 35px 120px rgba(15, 23, 42, 0.55);
            padding: 32px;
            display: flex;
            flex-direction: column;
            gap: 24px;
            justify-content: center;
            align-items: center;
        }

        .viewer__message {
            font-size: 1.0625rem;
            letter-spacing: 0.01em;
            text-align: center;
            line-height: 1.5;
            color: #cbd5f5;
            max-width: 32rem;
            transition: opacity 150ms ease-in-out;
        }

        .viewer__message--hidden {
            opacity: 0;
            pointer-events: none;
        }

        .viewer__message--error {
            color: #fca5a5;
        }

        .viewer__frame {
            flex: 1 1 auto;
            width: 100%;
            max-width: 100%;
            height: 100%;
            max-height: 100%;
            border-radius: 16px;
            border: 1px solid rgba(148, 163, 184, 0.35);
            overflow: hidden;
            background: rgba(15, 23, 42, 0.75);
            display: none;
        }

        .viewer__frame--visible {
            display: block;
        }

        .viewer__iframe {
            width: 100%;
            height: 100%;
            border: 0;
            background: #0f172a;
        }

        .viewer__status {
            width: 100%;
            max-width: 100%;
            padding: 12px 16px;
            border-radius: 12px;
            background: rgba(30, 41, 59, 0.75);
            border: 1px solid rgba(148, 163, 184, 0.25);
            color: #cbd5f5;
        }

        .viewer__status-title {
            font-size: 0.875rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin: 0 0 8px;
            color: rgba(148, 163, 184, 0.9);
        }

        .viewer__status-list {
            margin: 0;
            padding-left: 18px;
            font-size: 0.8125rem;
            display: grid;
            gap: 6px;
        }

        .viewer__status-item {
            display: grid;
            grid-template-columns: 92px 1fr;
            gap: 8px;
            align-items: center;
            background: rgba(15, 23, 42, 0.35);
            padding: 6px 10px;
            border-radius: 8px;
            border: 1px solid rgba(148, 163, 184, 0.15);
            list-style: none;
        }

        .viewer__status-time {
            font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
            font-size: 0.75rem;
            color: rgba(148, 163, 184, 0.9);
        }

        .viewer__status-code {
            font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
            font-size: 0.75rem;
            color: #facc15;
        }

        .viewer__status-detail {
            grid-column: 1 / -1;
            font-size: 0.8125rem;
        }

        @media (max-width: 768px) {
            main.viewer {
                width: calc(100vw - 32px);
                height: calc(100vh - 32px);
                padding: 24px;
            }

            .viewer__status-item {
                grid-template-columns: 1fr;
            }

            .viewer__status-time {
                order: 1;
            }

            .viewer__status-code {
                order: 2;
            }

            .viewer__status-detail {
                order: 3;
            }
        }
    </style>
</head>
<body>
<main class="viewer" role="main">
    <p id="viewerMessage" class="viewer__message">Preparing schedule…</p>
    <section id="viewerStatus" class="viewer__status" aria-live="polite" aria-atomic="false">
        <h2 class="viewer__status-title">Debug details</h2>
        <ol id="viewerStatusList" class="viewer__status-list"></ol>
    </section>
    <div id="viewerFrame" class="viewer__frame" aria-hidden="true"></div>
</main>
<script>
  (() => {
    const messageEl = document.getElementById("viewerMessage");
    const frameContainer = document.getElementById("viewerFrame");
    const statusList = document.getElementById("viewerStatusList");
    const params = new URLSearchParams(window.location.search);

    const MESSAGE_TYPE_CLOSE = "scheduler:print:close";

    function closeViewerWindow() {
      window.close();
      window.setTimeout(() => {
        if (window.closed) {
          return;
        }
        if (window.history.length > 1) {
          window.history.back();
          return;
        }
        window.location.replace("about:blank");
      }, 300);
    }

    window.addEventListener("message", (event) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      if (!event.data || event.data.type !== MESSAGE_TYPE_CLOSE) {
        return;
      }
      closeViewerWindow();
    });

    const token = params.get("token");
    const companyId = params.get("company_id");
    const storeId = params.get("store_id");
    const date = params.get("date");

    const ERROR_SESSION = "session";
    const ERROR_SCHEDULE = "schedule";
    const ERROR_FETCH = "fetch";
    const ERROR_PDF = "pdf";
    const ERROR_EMPTY = "empty";

    const hasRequiredParams = token && companyId && storeId && date;

    function logStatus(code, detail) {
      if (!statusList) {
        return;
      }
      const item = document.createElement("li");
      item.className = "viewer__status-item";
      const timestamp = new Date().toLocaleTimeString();
      const codeSpan = document.createElement("span");
      codeSpan.className = "viewer__status-code";
      codeSpan.textContent = code;
      const detailSpan = document.createElement("span");
      detailSpan.className = "viewer__status-detail";
      detailSpan.textContent = detail;
      const timeSpan = document.createElement("span");
      timeSpan.className = "viewer__status-time";
      timeSpan.textContent = timestamp;
      item.appendChild(timeSpan);
      item.appendChild(codeSpan);
      item.appendChild(detailSpan);
      statusList.appendChild(item);
    }

    function setMessage(text, isError = false, code = null) {
      if (!messageEl) {
        return;
      }
      if (text) {
        const suffix = code ? ` (Error code: ${code})` : "";
        messageEl.textContent = text + suffix;
        messageEl.classList.remove("viewer__message--hidden");
      } else {
        messageEl.textContent = "";
        messageEl.classList.add("viewer__message--hidden");
      }
      if (isError) {
        messageEl.classList.add("viewer__message--error");
      } else {
        messageEl.classList.remove("viewer__message--error");
      }
    }

    function setError(text, code = null) {
      setMessage(text, true, code);
      logStatus(code ? `error:${code}` : "error", text);
    }

    function raise(code, message) {
      const error = new Error(message);
      error.code = code;
      return error;
    }

    if (!hasRequiredParams) {
      setError("Missing schedule details. Please return to the scheduler and try again.");
      return;
    }

    logStatus("init", "Preparing printable schedule request");
    setMessage("Preparing schedule…");

    const scheduleUrl = new URL("api/schedule.php", window.location.href);
    scheduleUrl.search = params.toString();

    logStatus("fetch:init", "Requesting schedule data");
    fetch(scheduleUrl.toString(), {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          if (response.status === 403) {
            throw raise(ERROR_SESSION, "Session expired");
          }
          throw raise(ERROR_FETCH, "Failed to fetch schedule");
        }
        try {
          const json = await response.json();
          logStatus("fetch:success", "Schedule data received");
          return json;
        } catch (err) {
          throw raise(ERROR_FETCH, "Invalid schedule response");
        }
      })
      .then((schedule) => {
        if (!schedule || typeof schedule !== "object") {
          throw raise(ERROR_FETCH, "Missing schedule");
        }
        const day = schedule[date];
        if (!day || !Array.isArray(day.employees) || day.employees.length === 0) {
          logStatus("fetch:empty", "Schedule payload missing employees");
          throw raise(ERROR_SCHEDULE, "Schedule not found");
        }
        logStatus("iframe:init", "Loading printable schedule frame");
        loadPdf();
      })
      .catch((error) => {
        if (frameContainer) {
          frameContainer.innerHTML = "";
          frameContainer.classList.remove("viewer__frame--visible");
          frameContainer.setAttribute("aria-hidden", "true");
        }
        const errorCode = error && error.code ? error.code : "unknown";
        if (!error) {
          setError("We couldn't prepare the schedule for printing. Please try again.", errorCode);
          return;
        }
        switch (error.code) {
          case ERROR_SESSION:
            setError("Your session has expired. Please refresh the scheduler and try again.", error.code);
            break;
          case ERROR_SCHEDULE:
            setError("No schedule is available for the selected date.", error.code);
            break;
          default:
            setError("We couldn't prepare the schedule for printing. Please try again.", error.code);
            break;
        }
      });

    function loadPdf() {
      logStatus("iframe:request", "Requesting printable schedule HTML");
      setMessage("Loading printable schedule…");

      const printParams = new URLSearchParams(params);
      printParams.set("format", "html");
      printParams.set("debug", "1");

      const printUrl = new URL("api/print_schedule.php", window.location.href);
      printUrl.search = printParams.toString();

      if (!frameContainer) {
        setError("We couldn't open the printable schedule. Please try again.", ERROR_PDF);
        return;
      }

      const iframe = document.createElement("iframe");
      iframe.className = "viewer__iframe";
      iframe.title = "Schedule preview";
      iframe.src = printUrl.toString();

      let iframeSettled = false;
      const iframeTimeout = window.setTimeout(() => {
        if (iframeSettled) {
          return;
        }
        logStatus("iframe:timeout", "Printable schedule load timed out");
        setError("We couldn't load the printable schedule in time. Please try again.", "iframe_timeout");
      }, 20000);

      const handleSessionError = () => {
        frameContainer.innerHTML = "";
        frameContainer.classList.remove("viewer__frame--visible");
        frameContainer.setAttribute("aria-hidden", "true");
        iframeSettled = true;
        window.clearTimeout(iframeTimeout);
        logStatus("iframe:session", "Session issue detected by iframe");
        setError("Your session has expired. Please refresh the scheduler and try again.", ERROR_SESSION);
      };

      const handleGenericError = () => {
        frameContainer.innerHTML = "";
        frameContainer.classList.remove("viewer__frame--visible");
        frameContainer.setAttribute("aria-hidden", "true");
        iframeSettled = true;
        window.clearTimeout(iframeTimeout);
        logStatus("iframe:error", "Generic iframe load error");
        setError("We couldn't open the printable schedule. Please try again.", ERROR_PDF);
      };

      iframe.addEventListener(
        "load",
        () => {
          iframeSettled = true;
          window.clearTimeout(iframeTimeout);
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document || null;
            if (!doc) {
              handleGenericError();
              return;
            }

            const bodyText = (doc.body && doc.body.textContent ? doc.body.textContent : "").trim();
            const hasScheduleContent = doc.querySelector(".print-page") !== null;
            const debugCode = doc.querySelector("[data-print-debug-code]");
            const debugMessage = doc.querySelector("[data-print-debug-message]");

            if (!hasScheduleContent) {
              if (debugCode || debugMessage) {
                const code = debugCode ? debugCode.getAttribute("data-print-debug-code") : "unknown";
                const message = debugMessage ? debugMessage.getAttribute("data-print-debug-message") : "Printable schedule error";
                logStatus(`iframe:debug:${code}`, message || "Printable schedule error");
                setError(message || "We couldn't open the printable schedule. Please try again.", code || ERROR_PDF);
                return;
              }
              const normalized = bodyText.toLowerCase();
              if (normalized.includes("invalid token") || normalized.includes("forbidden")) {
                handleSessionError();
                return;
              }
              handleGenericError();
              return;
            }

            frameContainer.classList.add("viewer__frame--visible");
            frameContainer.setAttribute("aria-hidden", "false");
            logStatus("iframe:loaded", "Printable schedule ready");
            setMessage("Use your browser's Print command (Ctrl+P or Command+P) to print this schedule.");
          } catch (err) {
            handleGenericError();
          }
        },
        { once: true },
      );

      iframe.addEventListener("error", handleGenericError, { once: true });

      frameContainer.innerHTML = "";
      frameContainer.classList.remove("viewer__frame--visible");
      frameContainer.setAttribute("aria-hidden", "true");
      frameContainer.appendChild(iframe);
    }
  })();
</script>
</body>
</html>
