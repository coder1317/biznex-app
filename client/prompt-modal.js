// Global helper: showFormModal - displays a simple form modal and returns values
(function(){
    function showFormModal(options) {
        // options: { title, fields: [{name,label,type,placeholder,value,options}], submitText }
        return new Promise((resolve, reject) => {
            try {
                const modal = document.getElementById('promptModal');
                const container = document.getElementById('promptModalContent');
                if (!modal || !container) return resolve(null);
                container.innerHTML = '';

                const title = document.createElement('h3');
                title.textContent = options.title || 'Form';
                container.appendChild(title);

                const form = document.createElement('form');
                form.style.display = 'grid';
                form.style.gap = '10px';

                const fields = options.fields || [];
                fields.forEach(f => {
                    const group = document.createElement('div');
                    group.className = 'form-group';
                    const label = document.createElement('label');
                    label.textContent = f.label || f.name;
                    // Special handling for checkbox-group
                    if (f.type === 'checkbox-group' && Array.isArray(f.options)) {
                        const boxContainer = document.createElement('div');
                        boxContainer.style.display = 'flex';
                        boxContainer.style.flexDirection = 'column';
                        f.options.forEach(opt => {
                            const cbWrap = document.createElement('label');
                            cbWrap.style.display = 'flex';
                            cbWrap.style.alignItems = 'center';
                            cbWrap.style.gap = '8px';
                            const cb = document.createElement('input');
                            cb.type = 'checkbox';
                            cb.name = f.name; // use same name so FormData.getAll works
                            cb.value = opt.value;
                            if (Array.isArray(f.value) && f.value.includes(opt.value)) cb.checked = true;
                            cbWrap.appendChild(cb);
                            const span = document.createElement('span'); span.textContent = opt.label;
                            cbWrap.appendChild(span);
                            boxContainer.appendChild(cbWrap);
                        });
                        group.appendChild(label);
                        group.appendChild(boxContainer);
                    } else {
                        let input;
                        if (f.type === 'textarea') input = document.createElement('textarea');
                        else if (f.type === 'select') input = document.createElement('select');
                        else input = document.createElement('input');
                        if (f.type && f.type !== 'textarea' && f.type !== 'select') input.type = f.type;
                        input.name = f.name;
                        if (f.placeholder) input.placeholder = f.placeholder;
                        if (f.options && input.tagName === 'SELECT') {
                            f.options.forEach(opt => {
                                const o = document.createElement('option'); o.value = opt.value; o.textContent = opt.label; input.appendChild(o);
                            });
                        }
                        // Set value AFTER options are appended so <select> pre-selection works correctly
                        if (f.value !== undefined) input.value = f.value;
                        group.appendChild(label);
                        group.appendChild(input);
                    }
                    form.appendChild(group);
                });

                const actions = document.createElement('div');
                actions.style.display = 'flex';
                actions.style.justifyContent = 'flex-end';
                actions.style.gap = '8px';

                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'btn secondary';
                cancel.textContent = 'Cancel';
                cancel.onclick = () => { modal.classList.add('hidden'); resolve(null); };

                const submit = document.createElement('button');
                submit.type = 'submit';
                submit.className = 'btn primary';
                submit.textContent = options.submitText || 'OK';

                actions.appendChild(cancel);
                actions.appendChild(submit);
                form.appendChild(actions);

                form.onsubmit = (e) => {
                    e.preventDefault();
                    const formData = new FormData(form);
                    const out = {};
                    fields.forEach(f => {
                        if (f.type === 'checkbox-group') {
                            out[f.name] = formData.getAll(f.name) || [];
                        } else {
                            out[f.name] = formData.get(f.name);
                        }
                    });
                    modal.classList.add('hidden');
                    resolve(out);
                };

                container.appendChild(form);
                modal.classList.remove('hidden');
                setTimeout(() => { const el = container.querySelector('input,textarea,select'); if (el) el.focus(); }, 10);
            } catch (err) { reject(err); }
        });
    }

    // Enhanced fetchWithAuth attached to window so app.js can use it or be overridden
    async function enhancedFetchWithAuth(url, options = {}) {
        const token = localStorage.getItem('authToken');
        if (token) {
            options.headers = options.headers || {};
            options.headers['Authorization'] = `Bearer ${token}`;
        }
        try {
                const res = await fetch(url, options);
            if (res.status === 401) {
                // Phase 2: try silent token refresh, then retry once
                if (typeof window.refreshAccessToken === 'function') {
                    const refreshed = await window.refreshAccessToken();
                    if (refreshed) {
                        const newToken = localStorage.getItem('authToken');
                        if (newToken) {
                            options.headers = options.headers || {};
                            options.headers['Authorization'] = `Bearer ${newToken}`;
                        }
                        return fetch(url, options); // retry with fresh token
                    }
                }
                localStorage.removeItem('authToken');
                localStorage.removeItem('refreshToken');
                // show login modal if available
                if (typeof window.showLogin === 'function') window.showLogin();
                const body = await res.text().catch(() => '');
                const err = new Error('Unauthorized');
                err.response = res; err.body = body;
                throw err;
            }
            return res;
            } catch (err) {
                // Network error (e.g., connection refused) — surface a friendly toast
                console.error('Network error when calling', url, err);
                if (typeof window.showToast === 'function') {
                    window.showToast('Backend unreachable — please start the server', 'error', 5000);
                }
                throw err;
        }
    }

    window.showFormModal = showFormModal;
    window.fetchWithAuth = enhancedFetchWithAuth;
    // Stable reference that other scripts can call without risk of being overwritten
    window._enhancedFetchWithAuth = enhancedFetchWithAuth;
})();
