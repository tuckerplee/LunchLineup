(() => {
  function initStaffTable(token, companyId) {
    let page = 1;
    const pageSize = 50;
    const searchInput = document.getElementById('staffSearch');
    const tbody = document.querySelector('#staffTable tbody');
    const prev = document.getElementById('prevStaff');
    const next = document.getElementById('nextStaff');
    function load() {
      const params = new URLSearchParams({
        token,
        company_id: companyId,
        page,
        per_page: pageSize,
        includeAdmins: false,
      });
      const search = searchInput.value.trim();
      if (search !== '') params.append('search', search);
      fetch(`../superadmin-api/staff.php?${params.toString()}`)
        .then(r => {
          const total = parseInt(r.headers.get('X-Total-Count') || '0', 10);
          return r.json().then(data => ({ data, total }));
        })
        .then(({ data, total }) => {
          tbody.replaceChildren();
          data.forEach(s => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${s.id}</td><td>${s.name}</td><td>${s.storeId ?? ''}</td>`;
            const td = document.createElement('td');
            const edit = document.createElement('button');
            edit.textContent = 'Edit';
            edit.className = 'btn btn-sm btn-secondary me-2';
            edit.addEventListener('click', () => {
              openAdminModal(`staff.php?company_id=${companyId}&id=${s.id}`, 'Edit Staff');
            });
            const del = document.createElement('button');
            del.textContent = 'Delete';
            del.className = 'btn btn-sm btn-danger';
            del.addEventListener('click', () => {
              if (!confirm('Delete staff?')) return;
              fetch(`../superadmin-api/staff.php?token=${encodeURIComponent(token)}&company_id=${companyId}&id=${s.id}`, {
                method: 'DELETE',
              }).then(() => load());
            });
            td.appendChild(edit);
            td.appendChild(del);
            tr.appendChild(td);
            tbody.appendChild(tr);
          });
          const effectiveTotal = Number.isNaN(total) || total === 0 ? data.length : total;
          const totalPages = effectiveTotal === 0 ? 1 : Math.ceil(effectiveTotal / pageSize);
          prev.disabled = page <= 1;
          next.disabled = page >= totalPages;
        });
    }
    searchInput.addEventListener('input', () => {
      page = 1;
      load();
    });
    prev.addEventListener('click', () => {
      if (page > 1) {
        page--;
        load();
      }
    });
    next.addEventListener('click', () => {
      page++;
      load();
    });
    load();
  }

  function parseNumbers(str) {
    return str
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  }

  const numberPattern = /^-?\d+$/;

  function getSelectedValues(select) {
    return Array.from(select.selectedOptions)
      .map(option => option.value.trim())
      .filter(value => value !== '')
      .map(value => {
        if (numberPattern.test(value)) {
          const parsed = parseInt(value, 10);
          return Number.isNaN(parsed) ? value : parsed;
        }
        return value;
      });
  }

  function initStaffForm(token, companyId, staffId, options = {}) {
    const form = document.getElementById('staffForm');
    const companySelect = document.getElementById('companyId');
    const storeSelect = document.getElementById('storeId');
    const choreSelect = document.getElementById('tasks');
    let preferredChores = [];
    const isSuperAdmin = options.superAdmin === true;

    function normalizeLegacyLabel(value) {
      return value.trim().toLowerCase();
    }

    function normalizePreferenceValue(value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 0 ? value : null;
      }
      if (typeof value === 'bigint') {
        const converted = Number(value);
        return Number.isFinite(converted) && converted > 0 ? converted : null;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') {
          return null;
        }
        if (numberPattern.test(trimmed)) {
          const parsed = parseInt(trimmed, 10);
          return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
        }
        return trimmed;
      }
      if (typeof value === 'boolean') {
        return value ? 1 : null;
      }
      if (typeof value === 'object' && value !== null && 'value' in value) {
        return normalizePreferenceValue(value.value);
      }
      return null;
    }

    function buildPreferenceSets(values) {
      const idSet = new Set();
      const legacySet = new Set();
      values.forEach(value => {
        const normalized = normalizePreferenceValue(value);
        if (normalized === null) {
          return;
        }
        if (typeof normalized === 'number' && Number.isFinite(normalized)) {
          idSet.add(String(normalized));
        } else if (typeof normalized === 'string' && normalized !== '') {
          legacySet.add(normalizeLegacyLabel(normalized));
        }
      });
      return { idSet, legacySet };
    }

    function toBoolean(value, defaultValue = true) {
      if (value === null || value === undefined) {
        return defaultValue;
      }
      if (typeof value === 'boolean') {
        return value;
      }
      if (typeof value === 'number') {
        return value !== 0;
      }
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === '') {
          return defaultValue;
        }
        if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
          return true;
        }
        if (normalized === 'false' || normalized === '0' || normalized === 'no') {
          return false;
        }
      }
      return Boolean(value);
    }

    function extractTemplateId(chore) {
      const raw = chore?.id;
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw;
      }
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (numberPattern.test(trimmed)) {
          const parsed = parseInt(trimmed, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            return parsed;
          }
        }
      }
      return null;
    }

    function buildChoreLabel(chore, description) {
      const cues = [];
      const priorityValue = chore?.priority;
      if (priorityValue !== undefined && priorityValue !== null) {
        const priority = Number.parseInt(priorityValue, 10);
        if (!Number.isNaN(priority) && priority !== 0) {
          cues.push(`P${priority}`);
        }
      }
      const daypartValue = chore?.daypart ?? chore?.dayPart ?? '';
      if (typeof daypartValue === 'string') {
        const daypart = daypartValue.trim();
        if (daypart !== '') {
          cues.push(daypart);
        }
      }
      if (cues.length === 0) {
        return description;
      }
      return `${description} (${cues.join(' • ')})`;
    }

    function disableChoreSelect(message) {
      choreSelect.innerHTML = '';
      const option = document.createElement('option');
      option.value = '';
      option.textContent = message;
      option.disabled = true;
      option.selected = true;
      choreSelect.appendChild(option);
      choreSelect.disabled = true;
    }

    function renderChoreOptions(chores) {
      const filtered = Array.isArray(chores)
        ? chores.filter(chore => {
            if (!chore || typeof chore !== 'object') {
              return false;
            }
            const active = toBoolean(chore.isActive ?? chore.is_active, true);
            if (!active) {
              return false;
            }
            const autoAssignable = toBoolean(
              chore.autoAssignEnabled ?? chore.auto_assign_enabled ?? chore.autoAssign,
              true
            );
            return autoAssignable;
          })
        : [];

      if (filtered.length === 0) {
        disableChoreSelect('Add chores to assign preference');
        return;
      }

      const { idSet, legacySet } = buildPreferenceSets(preferredChores);
      const matchedIds = new Set();
      const matchedLegacy = new Set();

      choreSelect.disabled = false;
      choreSelect.innerHTML = '';

      filtered
        .slice()
        .sort((a, b) => {
          const aPriority = Number.parseInt(a?.priority, 10) || 0;
          const bPriority = Number.parseInt(b?.priority, 10) || 0;
          if (aPriority !== bPriority) {
            return bPriority - aPriority;
          }
          const aLabel = String(a?.description ?? '');
          const bLabel = String(b?.description ?? '');
          return aLabel.localeCompare(bLabel, undefined, { sensitivity: 'base' });
        })
        .forEach(chore => {
          const description = String(chore?.description ?? '').trim();
          const templateId = extractTemplateId(chore);
          if (description === '' || templateId === null) {
            return;
          }
          const option = document.createElement('option');
          option.value = String(templateId);
          option.textContent = buildChoreLabel(chore, description);
          const templateIdKey = String(templateId);
          if (idSet.has(templateIdKey)) {
            option.selected = true;
            matchedIds.add(templateIdKey);
          } else {
            const normalized = normalizeLegacyLabel(description);
            if (legacySet.has(normalized)) {
              option.selected = true;
              matchedLegacy.add(normalized);
            }
          }
          choreSelect.appendChild(option);
        });

      preferredChores.forEach(value => {
        const normalized = normalizePreferenceValue(value);
        if (normalized === null) {
          return;
        }
        const fallback = document.createElement('option');
        if (typeof normalized === 'number' && Number.isFinite(normalized)) {
          const key = String(normalized);
          if (matchedIds.has(key)) {
            return;
          }
          fallback.value = key;
          fallback.textContent = `Template #${normalized} (unavailable)`;
        } else {
          const label = String(normalized);
          const legacyKey = normalizeLegacyLabel(label);
          if (matchedLegacy.has(legacyKey)) {
            return;
          }
          fallback.value = label;
          fallback.textContent = `${label} (unavailable)`;
        }
        fallback.selected = true;
        choreSelect.appendChild(fallback);
      });
    }

    function currentCompanyId() {
      const cid = parseInt(companySelect.value, 10);
      if (!Number.isNaN(cid)) {
        return cid;
      }
      return Number.isNaN(companyId) ? companyId : parseInt(companyId, 10);
    }

    function currentStoreId() {
      const sid = parseInt(storeSelect.value, 10);
      return Number.isNaN(sid) ? 0 : sid;
    }

    function fetchChoresForStore(storeId, cid) {
      if (!storeId) {
        disableChoreSelect('Select a store to load chores');
        return Promise.resolve();
      }
      const parsedCompany = typeof cid === 'number' ? cid : parseInt(cid, 10);
      const resolvedCompanyId = Number.isFinite(parsedCompany)
        ? parsedCompany
        : currentCompanyId();
      const url = `../api/chores.php?token=${encodeURIComponent(token)}&company_id=${resolvedCompanyId}&store_id=${storeId}`;
      return fetch(url)
        .then(r => (r.ok ? r.json() : []))
        .then(data => {
          renderChoreOptions(Array.isArray(data) ? data : []);
        })
        .catch(() => {
          renderChoreOptions([]);
        });
    }

    disableChoreSelect('Select a store to load chores');

    function loadStores(cid) {
      storeSelect.innerHTML = '<option value="">-- None --</option>';
      const base = isSuperAdmin ? '../superadmin-api' : '../api';
      return fetch(
        `${base}/stores.php?token=${encodeURIComponent(token)}&company_id=${cid}`
      )
        .then((r) => (r.ok ? r.json() : []))
        .then((stores) => {
          if (!Array.isArray(stores)) return;
          stores.forEach((s) => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            storeSelect.appendChild(opt);
          });
        });
    }

    function setupRestricted() {
      const opt = document.createElement('option');
      opt.value = companyId;
      opt.textContent = options.companyName || '';
      companySelect.appendChild(opt);
      companySelect.disabled = true;
      return loadStores(companyId);
    }

    let initPromise;
    if (!isSuperAdmin) {
      initPromise = setupRestricted();
    } else {
      initPromise = fetch(
        `../superadmin-api/companies.php?token=${encodeURIComponent(token)}`
      )
        .then((r) => {
          if (!r.ok) throw new Error('companies fetch failed');
          return r.json();
        })
        .then((companies) => {
          if (!Array.isArray(companies)) throw new Error('invalid response');
          companies.forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            companySelect.appendChild(opt);
          });
          companySelect.value = companyId;
          return loadStores(companyId);
        })
        .catch(() => setupRestricted());
    }

    initPromise
      .then(() => {
        if (!staffId) {
          return fetchChoresForStore(currentStoreId(), currentCompanyId());
        }

        return fetch(
          `../superadmin-api/staff.php?token=${encodeURIComponent(token)}&company_id=${companyId}&admins=false`
        )
          .then((r) => r.json())
          .then((list) => {
            const st = Array.isArray(list) ? list.find((x) => x.id == staffId) : null;
            if (!st) {
              return fetchChoresForStore(currentStoreId(), currentCompanyId());
            }

            document.getElementById('name').value = st.name || '';
            document.getElementById('lunchDuration').value =
              st.lunchDuration || 30;
            document.getElementById('registers').value =
              (st.pos || []).join(', ');
            preferredChores = Array.isArray(st.tasks)
              ? st.tasks
                  .map(normalizePreferenceValue)
                  .filter(value => value !== null && value !== '')
              : [];
            companySelect.value = st.companyId;

            return loadStores(st.companyId).then(() => {
              if (st.storeId) {
                storeSelect.value = st.storeId;
              }
              return fetchChoresForStore(currentStoreId(), st.companyId);
            });
          });
      })
      .catch(() => {
        renderChoreOptions([]);
      });

    if (isSuperAdmin) {
      companySelect.addEventListener('change', () => {
        const cid = parseInt(companySelect.value, 10);
        preferredChores = [];
        loadStores(cid).then(() => {
          fetchChoresForStore(currentStoreId(), cid);
        });
      });
    }

    storeSelect.addEventListener('change', () => {
      preferredChores = [];
      fetchChoresForStore(currentStoreId(), currentCompanyId());
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const cid = parseInt(companySelect.value, 10);
      const payload = {
        id: staffId || undefined,
        name: document.getElementById('name').value,
        lunchDuration: parseInt(
          document.getElementById('lunchDuration').value,
          10
        ),
        preferredRegisters: parseNumbers(
          document.getElementById('registers').value
        ),
        preferredTasks: getSelectedValues(choreSelect),
      };
      const sid = storeSelect.value;
      if (sid !== '') {
        payload.storeId = parseInt(sid, 10);
      }
      fetch(
        `../superadmin-api/staff.php?token=${encodeURIComponent(
          token
        )}&company_id=${cid}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      ).then(() => {
        adminGoBack('staff_saved');
      });
    });
  }

  window.SuperAdminStaff = { initStaffTable, initStaffForm };
})();
