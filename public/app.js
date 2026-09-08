        const BACKEND_URL = window.location.origin;

        // Состояние навигации
        let state = { view: 'courses', course: null, semester: null, subject: null };

        // Каталог загружается один раз
        let catalog = Object.create(null);

        // Структура для навигации, строится из каталога
        let tree = Object.create(null); // { course: { semester: { subject: [ {fileId, item} ] } } }

        const appView = document.getElementById('app-view');
        const navActions = document.getElementById('nav-actions');



        // Строим дерево навигации из плоского каталога
        function buildTree(cat) {
            const t = Object.create(null);
            for (const [fileId, item] of Object.entries(cat)) {
                const { course, semester, subject } = item;
                if (!t[course]) t[course] = Object.create(null);
                if (!t[course][semester]) t[course][semester] = Object.create(null);
                if (!t[course][semester][subject]) t[course][semester][subject] = [];
                t[course][semester][subject].push({ fileId, item });
            }
            return t;
        }

        async function init() {
            appView.innerHTML = '<div class="text-center text-zinc-500 text-sm py-12">Загрузка...</div>';
            try {
                const res = await fetch(`${BACKEND_URL}/api/catalog`);
                if (!res.ok) throw new Error('Catalog unavailable');
                catalog = await res.json();
                tree = buildTree(catalog);
                render();
            } catch (e) {
                appView.innerHTML = '<div class="text-center text-zinc-500 text-sm py-12">Ошибка загрузки каталога</div>';
            }
        }

        function render() {
            appView.innerHTML = '';
            navActions.innerHTML = '';
            if (state.view === 'courses')   renderCourses();
            if (state.view === 'semesters') renderSemesters();
            if (state.view === 'subjects')  renderSubjects();
            if (state.view === 'files')     renderFiles();
        }

        function renderCourses() {
            const courses = Object.keys(tree).sort();
            let html = `
                <div class="mb-6 flex items-center justify-between">
                    <div>
                        <h2 class="text-xl font-semibold tracking-tight text-zinc-100">Выберите курс</h2>
                        <p class="text-xs text-zinc-500 mt-1">Доступны материалы с 1 по 6 курс обучения</p>
                    </div>
                    <button data-action="openSupportModal" class="py-2 px-3.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800 text-xs font-medium text-zinc-200 transition flex items-center gap-1.5 shadow-sm">
                        <svg class="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
                        Поддержка
                    </button>
                </div>
                <div class="grid grid-cols-2 gap-3">`;
            courses.forEach(c => {
                html += `
                    <button ${actionAttr("selectCourse",c)} class="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-900 transition flex flex-col items-start text-left group">
                        <span class="text-xs text-zinc-500 group-hover:text-zinc-400">Уровень</span>
                        <span class="text-base font-medium text-zinc-200 mt-1">${escapeHtml(c)}</span>
                    </button>`;
            });
            html += '</div>';
            appView.innerHTML = html;
        }

        function renderSemesters() {
            navActions.innerHTML = `<button data-action="goBack" class="text-xs text-zinc-400 hover:text-zinc-200 transition">← Назад</button>`;
            const semesters = Object.keys(tree[state.course]).sort();
            let html = `
                <div class="mb-6">
                    <h2 class="text-xl font-semibold tracking-tight text-zinc-100">${escapeHtml(state.course)}</h2>
                    <p class="text-xs text-zinc-500 mt-1">Выберите семестр обучения</p>
                </div>
                <div class="space-y-2">`;
            semesters.forEach(s => {
                html += `
                    <button ${actionAttr("selectSemester",s)} class="w-full p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-900 transition flex items-center justify-between text-left">
                        <span class="text-sm font-medium text-zinc-200">${escapeHtml(s)}</span>
                        <span class="text-zinc-600">→</span>
                    </button>`;
            });
            html += '</div>';
            appView.innerHTML = html;
        }

        function renderSubjects() {
            navActions.innerHTML = `<button data-action="goBack" class="text-xs text-zinc-400 hover:text-zinc-200 transition">← Назад</button>`;
            const subjects = Object.keys(tree[state.course][state.semester]).sort();
            let html = `
                <div class="mb-6">
                    <h2 class="text-xl font-semibold tracking-tight text-zinc-100">${escapeHtml(state.semester)}</h2>
                    <p class="text-xs text-zinc-500 mt-1">Выберите учебный предмет</p>
                </div>
                <div class="space-y-2">`;
            subjects.forEach(sub => {
                const count = tree[state.course][state.semester][sub].length;
                html += `
                    <button ${actionAttr("selectSubject",sub)} class="w-full p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-900 transition flex items-center justify-between text-left">
                        <span class="text-sm font-medium text-zinc-200">${escapeHtml(sub)}</span>
                        <span class="text-xs text-zinc-500">${count} файл(ов)</span>
                    </button>`;
            });
            html += '</div>';
            appView.innerHTML = html;
        }

        function renderFiles() {
            navActions.innerHTML = `<button data-action="goBack" class="text-xs text-zinc-400 hover:text-zinc-200 transition">← Назад</button>`;
            const entries = tree[state.course][state.semester][state.subject];

            // Группируем по имени файла (одно задание = несколько вариантов)
            const groups = Object.create(null);
            entries.forEach(({ fileId, item }) => {
                if (!groups[item.name]) groups[item.name] = { name: item.name, desc: item.desc, variants: [] };
                groups[item.name].variants.push({ fileId, item });
            });

            let html = `
                <div class="mb-6">
                    <h2 class="text-xl font-semibold tracking-tight text-zinc-100">${escapeHtml(state.subject)}</h2>
                    <p class="text-xs text-zinc-500 mt-1">Материалы с отправкой в чат</p>
                </div>
                <div class="space-y-2">`;

            Object.values(groups).forEach(group => {
                const hasPaid = group.variants.some(v => v.item.type === 'paid');
                const minPrice = hasPaid ? Math.min(...group.variants.filter(v => v.item.type === 'paid').map(v => v.item.priceStars).filter(Number.isInteger)) : 0;
                const badge = hasPaid
                    ? `<span class="text-[10px] uppercase font-semibold tracking-wider px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">${Number.isFinite(minPrice) ? "от " + minPrice + " ★" : "Скоро"}</span>`
                    : `<span class="text-[10px] uppercase font-semibold tracking-wider px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">Бесплатно</span>`;

                html += `
                    <div ${actionAttr("openFileModal",group)} class="w-full p-4 rounded-xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-900 transition flex items-center justify-between text-left cursor-pointer">
                        <div>
                            <div class="text-sm font-medium text-zinc-200">${escapeHtml(group.name)}</div>
                            <div class="text-xs text-zinc-500 mt-0.5">${group.variants.length} вариант(ов)</div>
                        </div>
                        <div>${badge}</div>
                    </div>`;
            });
            html += '</div>';
            appView.innerHTML = html;
        }

        function selectCourse(c)   { state.course = c; state.view = 'semesters'; render(); }
        function selectSemester(s) { state.semester = s; state.view = 'subjects'; render(); }
        function selectSubject(s)  { state.subject = s; state.view = 'files'; render(); }

        function goBack() {
            if (state.view === 'semesters') { state.view = 'courses'; }
            else if (state.view === 'subjects') { state.view = 'semesters'; }
            else if (state.view === 'files') { state.view = 'subjects'; }
            render();
        }

        function openFileModal(group) {
            const content = document.getElementById('modal-content');
            content.innerHTML = `
                <div class="mb-4">
                    <span class="text-xs text-zinc-500 uppercase tracking-wider">${escapeHtml(state.subject)}</span>
                    <h3 class="text-lg font-medium text-zinc-100 mt-1">${escapeHtml(group.name)}</h3>
                </div>
                <p class="text-xs text-zinc-400 mb-8">${escapeHtml(group.desc || '')}</p>
                <div class="space-y-2" id="modal-actions-container">
                    <button ${actionAttr("showVariants",group)} class="w-full py-2.5 px-4 rounded-xl bg-zinc-100 hover:bg-white text-zinc-950 font-medium text-xs transition">Выбрать вариант</button>
                    <button ${actionAttr("openTaskInfo",group)} class="w-full py-2.5 px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium text-xs transition">Ознакомиться с заданием</button>
                </div>`;
            document.getElementById('modal').classList.replace('hidden', 'flex');
        }

        function openTaskInfo(group) {
            const preview = group.variants.find(v => v.item.hasTaskFile);
            if (preview) { handleAction(preview.fileId, true); return; }
            const content = document.getElementById('modal-content');
            content.innerHTML = `
                <div class="mb-4">
                    <span class="text-xs text-zinc-500 uppercase tracking-wider">${escapeHtml(state.subject)}</span>
                    <h3 class="text-lg font-medium text-zinc-100 mt-1">${escapeHtml(group.name)}</h3>
                </div>
                <div class="bg-zinc-800/30 border border-zinc-700/50 rounded-lg p-4 mb-4 max-h-64 overflow-y-auto">
                    <p class="text-sm text-zinc-300 leading-relaxed">${escapeHtml(group.desc || 'Описание недоступно')}</p>
                    <div class="mt-4 text-xs text-zinc-500">
                        <p><strong>Предмет:</strong> ${escapeHtml(state.subject)}</p>
                        <p><strong>Вариантов:</strong> ${group.variants.length}</p>
                    </div>
                </div>
                <button ${actionAttr("openFileModal",group)} class="w-full py-2.5 px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium text-xs transition">← Назад</button>`;
        }

        function showVariants(group) {
            const container = document.getElementById('modal-actions-container');
            let html = `<div class="text-xs font-medium text-zinc-300 mb-2">Выберите вариант:</div><div class="space-y-2 max-h-48 overflow-y-auto pr-1">`;
            group.variants.forEach(({ fileId, item }) => {
                const actionText = !item.available ? 'Скоро' : item.type === 'free' ? 'Получить бесплатно' : `Оплатить и получить (${item.priceStars} ★)`;
                html += `
                    <div class="flex items-center justify-between p-2.5 rounded-lg bg-zinc-950/50 border border-zinc-800/65">
                        <span class="text-xs text-zinc-200 font-medium">${escapeHtml(item.variant)}</span>
                        <button ${actionAttr("handleAction",fileId)} ${item.available ? "" : "disabled"} class="py-1.5 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] transition">${actionText}</button>
                    </div>`;
            });
            html += `</div><button ${actionAttr("openFileModal",group)} class="w-full mt-3 py-2 px-4 rounded-xl bg-zinc-950 text-zinc-400 hover:text-zinc-200 text-xs transition">← Назад</button>`;
            container.innerHTML = html;
        }

        const requests = new Map();
        let busy = false;
        async function api(path, body) {
            const initData = window.Telegram?.WebApp?.initData;
            if (!initData) throw new Error('Откройте приложение через Telegram.');
            const response = await fetch(BACKEND_URL + '/api' + path, {
                method: body ? 'POST' : 'GET',
                headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(25000)
            });
            const data = await response.json();
            if (!response.ok) throw Object.assign(new Error(data.error || 'Не удалось выполнить запрос.'), { status: response.status });
            return data;
        }
        async function handleAction(fileId, preview = false) {
            if (busy) return;
            busy = true;
            const key = fileId + ':' + preview;
            try {
                const tg = window.Telegram?.WebApp;
                if (!tg?.initData) throw new Error('Откройте приложение через Telegram.');
                if (tg.isVersionAtLeast?.('6.9') && !tg.initDataUnsafe?.user?.allows_write_to_pm) {
                    const allowed = await new Promise(resolve => tg.requestWriteAccess(resolve));
                    if (!allowed) throw new Error('Разрешите боту присылать документы или нажмите /start в его чате.');
                }
                if (!requests.has(key)) requests.set(key, crypto.randomUUID());
                const data = await api('/action', { fileId, preview, requestKey: requests.get(key) });
                if (data.queued) {
                    requests.delete(key);
                    showToast('Документ поставлен в очередь. Он придёт в чат с ботом.');
                    closeModal();
                } else if (data.invoiceUrl) {
                    if (!tg.isVersionAtLeast?.('6.1')) throw new Error('Обновите Telegram для оплаты.');
                    await new Promise(resolve => tg.openInvoice(data.invoiceUrl, status => {
                        if (status === 'paid') {
                            requests.delete(key);
                            showToast('Оплата завершена. Документ придёт в чат с ботом.');
                            closeModal();
                        } else if (status === 'pending') showToast('Платёж обрабатывается. Дождитесь сообщения бота.');
                        else showToast(status === 'cancelled' ? 'Оплата отменена.' : 'Оплата не завершена. Повторите попытку.');
                        resolve();
                    }));
                }
            } catch (e) {
                if (e.status === 409) requests.delete(key);
                showToast(e.name === 'TimeoutError' ? 'Сервер отвечает долго. Повторите запрос — заказ сохранён.' : e.message);
            } finally { busy = false; }
        }

        function showToast(msg) {
            const t = document.createElement('div');
            t.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 bg-zinc-900 border border-zinc-800 text-zinc-200 text-xs px-4 py-2 rounded-xl shadow-lg z-[100]';
            t.innerText = msg;
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 2500);
        }

        function closeModal() {
            document.getElementById('modal').classList.replace('flex', 'hidden');
        }
        function openSupportModal() {
            document.getElementById('support-modal').classList.replace('hidden', 'flex');
        }
        function closeSupportModal() {
            document.getElementById('support-modal').classList.replace('flex', 'hidden');
        }

        async function sendSupportMessage(e) {
            e.preventDefault();
            const input = document.getElementById('chat-input');
            const msgs = document.getElementById('chat-messages');
            const text = input.value.trim();
            if (!text) return;
            const submit = document.querySelector('#chat-form button');
            submit.disabled = true;
            try { await api('/support', { text }); }
            catch (error) { showToast(error.message); return; }
            finally { submit.disabled = false; }
            const d = document.createElement('div');
            d.className = 'bg-zinc-800 text-zinc-100 p-3 rounded-xl max-w-[85%] ml-auto text-right text-xs';
            d.textContent = text;
            msgs.appendChild(d);
            input.value = '';
            msgs.scrollTop = msgs.scrollHeight;
            setTimeout(() => {
                const r = document.createElement('div');
                r.className = 'bg-zinc-900 border border-zinc-800 p-3 rounded-xl text-zinc-300 max-w-[85%] text-xs';
                r.textContent = 'Вопрос передан поддержке. Ответ придёт в чат с ботом.';
                msgs.appendChild(r);
                msgs.scrollTop = msgs.scrollHeight;
            }, 1000);
        }

        function escapeHtml(value) {
            return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
        function actionAttr(action, value) {
            return 'data-action="' + action + '" data-value="' + escapeHtml(JSON.stringify(value)) + '"';
        }
        const actions = { selectCourse, selectSemester, selectSubject, openFileModal, openTaskInfo, showVariants, handleAction, goBack, openSupportModal, closeSupportModal, closeModal };
        document.addEventListener('click', event => {
            const button = event.target.closest('[data-action]');
            if (!button || button.disabled || !Object.hasOwn(actions, button.dataset.action)) return;
            actions[button.dataset.action](button.dataset.value ? JSON.parse(button.dataset.value) : undefined);
        });
        document.getElementById('chat-form').addEventListener('submit', sendSupportMessage);
        document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); closeSupportModal(); } });
        window.Telegram?.WebApp?.ready();
        window.Telegram?.WebApp?.expand();
        init();
