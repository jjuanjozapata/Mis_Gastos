
import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';
import createDOMPurify from 'dompurify';

const DOMPurify = createDOMPurify(window);
window.supabase = window.supabase || { createClient };
window.DOMPurify = window.DOMPurify || DOMPurify;
window.Chart = window.Chart || Chart;

// [CISO] Inicialización resiliente y segura (Vite AST Safe Parser)
        const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://znszebnjcgjfzxvnexxd.supabase.co';
        const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || window.ENV_SUPABASE_KEY || 'znszebnjcgjfzxvnexxd';
        
        let db = null;
        if (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function') {
            try {
                // Validación estricta para atrapar bloqueos de privacidad del navegador (Ej. Modo Incógnito estricto)
                const storageDisponible = window.localStorage ? window.localStorage : null;
                db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                    auth: {
                        storage: storageDisponible,
                        autoRefreshToken: true,
                        persistSession: true
                    }
                });
            } catch (storageErr) {
                console.error('[CISO Guard] Error crítico de permisos en Storage. PWA operará en modo memoria volátil:', storageErr);
                // Fallback silencioso sin persistencia local, evita el bloqueo de renderizado
                db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
            }
        } else {
            console.error('[CISO Guard] Instancia nativa de Supabase no detectada en el objeto global.');
        }

        const escapeHTML = str => {
            if (!str) return '';
            if (typeof window !== 'undefined' && window.DOMPurify) {
                return window.DOMPurify.sanitize(String(str), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
            }
            return String(str).replace(/[&<>'"]/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[tag]));
        };
        
        function leerStorageSeguro(clave, valorPorDefecto) {
            try {
                const item = localStorage.getItem(clave);
                return item ? JSON.parse(item) : valorPorDefecto;
            } catch (e) {
                console.warn(`Aviso: Error al parsear ${clave} en localStorage, reiniciando valor.`);
                return valorPorDefecto;
            }
        }

        let monedaActual = localStorage.getItem('moneda_mis_gastos') || 'COP';
        let modoPrivacidad = localStorage.getItem('modo_privacidad_gastos') === 'true';

        window.addEventListener('unhandledrejection', event => {
            console.warn('Operación en segundo plano pausada por red o sesión:', event.reason);
            event.preventDefault();
        });

        let ultimoBalanceCalculado = 0;
        let ultimosIngresosCalculados = 0;
        let ultimosGastosCalculados = 0;
        let ultimaMatrizGastos = [];
        let transaccionesCacheActuales = [];
        let categoriaEdicionId = null; // [CISO FIX] Declaración explícita para prevenir ReferenceError en modo módulo

        let formateadorRaw = new Intl.NumberFormat('es-CO', { style: 'currency', currency: monedaActual, maximumFractionDigits: 0 });
        // [NUEVO] Caché global inmutable para inputs numéricos (Zero GC Thrashing)
        let formateadorNumerico = new Intl.NumberFormat('es-CO');

        function formatearMoneda(val) {
            if (modoPrivacidad) return '••••••••';
            return formateadorRaw.format(val);
        }

        function actualizarFormatoMoneda(nuevaMoneda) {
            monedaActual = nuevaMoneda;
            localStorage.setItem('moneda_mis_gastos', nuevaMoneda);
            let locale = 'es-CO';
            if (nuevaMoneda === 'USD') locale = 'en-US';
            if (nuevaMoneda === 'PEN') locale = 'es-PE';
            formateadorRaw = new Intl.NumberFormat(locale, { style: 'currency', currency: nuevaMoneda, maximumFractionDigits: 0 });
            formateadorNumerico = new Intl.NumberFormat(locale);
            const simEl = document.getElementById('simbolo-moneda-plan');
            if (simEl) simEl.textContent = nuevaMoneda === 'USD' ? '$' : (nuevaMoneda === 'PEN' ? 'S/.' : '$');
            actualizarPantalla();
            if (!document.getElementById('pantalla-dashboard')?.classList.contains('hidden')) {
                cargarEstadisticas();
            }
        }

        const selMoneda = document.getElementById('selector-moneda');
        if (selMoneda) selMoneda.value = monedaActual;
        selMoneda?.addEventListener('change', (e) => {
            actualizarFormatoMoneda(e.target.value);
            mostrarToast('Moneda actualizada con éxito');
        });

        // [CISO V8-Fix] Elevación de memoria para erradicar el Temporal Dead Zone (Error 'He')
        let candadoSincronizacionOffline = false;

        function actualizarEstadoRed() {
            const banner = document.getElementById('network-banner');
            if (banner) {
                if (!navigator.onLine) {
                    banner.classList.remove('hidden');
                } else {
                    banner.classList.add('hidden');
                }
            }
            if (navigator.onLine) {
                sincronizarColaOffline();
            }
        }
        window.addEventListener('online', actualizarEstadoRed);
        window.addEventListener('offline', actualizarEstadoRed);
        
        // [CISO] Desplazado al DOMContentLoaded para evitar fallos de lectura de classList en UI
        document.addEventListener('DOMContentLoaded', actualizarEstadoRed);

        async function sincronizarColaOffline() {
            if (candadoSincronizacionOffline) return;
            
            let queue = leerStorageSeguro('offline_queue', []);
            let queuePlanes = leerStorageSeguro('offline_queue_planes', []);
            
            if (queue.length === 0 && queuePlanes.length === 0) return;

            candadoSincronizacionOffline = true;
            try {
                const { data: { session } } = await db.auth.getSession();
                if (!session) return;

                mostrarToast('🔄 Sincronizando datos pendientes con la nube...');
                let huboSincronizacion = false;

                if (queue.length > 0) {
                    const itemsConUsuario = queue.map(item => ({ ...item, user_id: session.user.id }));
                    const idsProcesados = itemsConUsuario.map(i => i.id);
                    const { error: errTrans } = await db.from('transacciones').insert(itemsConUsuario);
                    
                    if (!errTrans) {
                        let colaActual = leerStorageSeguro('offline_queue', []);
                        let colaRestante = colaActual.filter(item => !idsProcesados.includes(item.id));
                        
                        if (colaRestante.length > 0) {
                            localStorage.setItem('offline_queue', JSON.stringify(colaRestante));
                        } else {
                            localStorage.removeItem('offline_queue');
                        }
                        huboSincronizacion = true;
                    }
                }

                if (queuePlanes.length > 0) {
                    let planesPendientes = [...queuePlanes];
                    
                    for (let op of queuePlanes) {
                        // Mitigación de desincronización: Calculamos en tiempo real con el servidor
                        const { data: planRemoto } = await db.from('planes').select('monto_acumulado').eq('id', op.planId).single();
                        const baseAcumulado = planRemoto ? parseFloat(planRemoto.monto_acumulado || 0) : 0;
                        const valorSeguro = op.abono ? (baseAcumulado + op.abono) : op.nuevoAcumulado;

                        const { error: errPlan } = await db.from('planes')
                            .update({ monto_acumulado: valorSeguro })
                            .eq('id', op.planId)
                            .eq('user_id', session.user.id);
                            
                        if (!errPlan) {
                            planesPendientes = planesPendientes.filter(p => p.planId !== op.planId);
                            huboSincronizacion = true;
                        }
                    }
                    
                    if (planesPendientes.length > 0) {
                        localStorage.setItem('offline_queue_planes', JSON.stringify(planesPendientes));
                    } else {
                        localStorage.removeItem('offline_queue_planes');
                    }
                }

                if (huboSincronizacion) {
                    mostrarToast('⚡ Sincronizados registros pendientes offline');
                    cargarEstadisticas();
                    cargarPlanes();
                }
            } catch (error) {
                console.warn('[CISO Guard] Sincronización pausada por inestabilidad de red o sesión:', error.message);
            } finally {
                candadoSincronizacionOffline = false;
            }
        }
           
        async function verificarEstadoSesion() {
            try {
                const { data: sessionData, error: sessionError } = await db.auth.getSession();
                if (sessionError) throw sessionError;
                actualizarUIIngreso(sessionData?.session || null);
            } catch (error) {
                console.warn('[CISO Security Guard] Red inestable al validar sesión inicial:', error.message);
                actualizarUIIngreso(null);
            }
        }

        function actualizarUIIngreso(session) {
            const divNoAuth = document.getElementById('contenedor-no-autenticado');
            const divAuth = document.getElementById('contenedor-autenticado');
            const emailDisplay = document.getElementById('user-email-display');
            const infoTexto = document.getElementById('info-sesion-texto');
            const modalBienvenida = document.getElementById('modal-bienvenida');
            const btnRegistrar = document.getElementById('btn-registrar');
            const btnLogin = document.getElementById('btn-iniciar-sesion');

            if (!divNoAuth || !divAuth || !infoTexto) return;

            if (session && session.user) {
                if (modalBienvenida) {
                    modalBienvenida.classList.add('hidden');
                    modalBienvenida.classList.remove('flex');
                }
                
                const isAnonymous = session.user.is_anonymous;

                if (isAnonymous) {
                    divNoAuth.classList.remove('hidden');
                    divAuth.classList.add('hidden');
                    infoTexto.textContent = "Estás usando una cuenta temporal. Conecta un correo y contraseña para no perder tus datos.";
                    if (btnRegistrar) btnRegistrar.textContent = "Guardar mi progreso";
                    if (btnLogin) btnLogin.classList.add('hidden');
                } else {
                    divNoAuth.classList.add('hidden');
                    divAuth.classList.remove('hidden');
                    if (emailDisplay) emailDisplay.textContent = session.user.email;
                    infoTexto.textContent = "Sesión activa. Tus registros están sincronizados con tu cuenta personal.";
                }
            } else {
                divNoAuth.classList.remove('hidden');
                divAuth.classList.add('hidden');
                infoTexto.textContent = "Inicia sesión o crea una cuenta para sincronizar tus datos.";
                if (btnRegistrar) btnRegistrar.textContent = "Crear Cuenta";
                if (btnLogin) btnLogin.classList.remove('hidden');
                
                if (modalBienvenida) {
                    modalBienvenida.classList.remove('hidden');
                    modalBienvenida.classList.add('flex');
                }
            }
        }

        document.getElementById('btn-bienvenida-anonimo')?.addEventListener('click', async () => {
            const { data: anonData, error: anonError } = await db.auth.signInAnonymously();
            if (anonError) {
                mostrarToast('Error al entrar: ' + anonError.message, 'error');
            } else {
                mostrarToast('¡Modo invitado activado! Explora libremente.');
                actualizarUIIngreso(anonData.session);
                cargarEstadisticas();
                cargarPlanes();
            }
        });

        document.getElementById('btn-bienvenida-login')?.addEventListener('click', () => {
            document.getElementById('modal-bienvenida')?.classList.add('hidden');
            document.getElementById('modal-bienvenida')?.classList.remove('flex');
            cambiarTab('ajustes');
        });

        document.getElementById('btn-bienvenida-registro')?.addEventListener('click', () => {
            document.getElementById('modal-bienvenida')?.classList.add('hidden');
            document.getElementById('modal-bienvenida')?.classList.remove('flex');
            cambiarTab('ajustes');
        });

        document.getElementById('btn-iniciar-sesion')?.addEventListener('click', async () => {
            const btnLogin = document.getElementById('btn-iniciar-sesion');
            if (!btnLogin || btnLogin.disabled) return;

            const emailInput = document.getElementById('auth-email');
            const passwordInput = document.getElementById('auth-password');
            if (!emailInput || !passwordInput) return;

            const email = emailInput.value.trim();
            const password = passwordInput.value.trim();

            if (!email || !password) {
                mostrarToast('Ingresa correo y contraseña', 'error');
                return;
            }

            btnLogin.disabled = true;
            const textoOriginal = btnLogin.textContent;
            btnLogin.textContent = 'Verificando...';

            try {
                const { data: loginData, error: loginError } = await db.auth.signInWithPassword({ email, password });
                if (loginError) throw loginError;
                mostrarToast('¡Bienvenido de vuelta!');
                passwordInput.value = '';
                actualizarUIIngreso(loginData.session);
                cargarEstadisticas();
                cargarPlanes();
            } catch (err) {
                mostrarToast('Error al iniciar sesión: ' + err.message, 'error');
            } finally {
                if (btnLogin) {
                    btnLogin.disabled = false;
                    btnLogin.textContent = textoOriginal;
                }
            }
        });

        document.getElementById('btn-registrar')?.addEventListener('click', async () => {
            const btnRegistrar = document.getElementById('btn-registrar');
            if (!btnRegistrar || btnRegistrar.disabled) return;

            const emailInput = document.getElementById('auth-email');
            const passwordInput = document.getElementById('auth-password');
            if (!emailInput || !passwordInput) return;

            const email = emailInput.value.trim().toLowerCase();
            const password = passwordInput.value.trim();

            if (!email || !password) {
                mostrarToast('Ingresa correo y contraseña', 'error');
                return;
            }

            const regexEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!regexEmail.test(email)) {
                mostrarToast('Ingresa un correo electrónico válido', 'error');
                return;
            }

            if (password.length < 6) {
                mostrarToast('La contraseña debe tener al menos 6 caracteres', 'error');
                return;
            }
            
            btnRegistrar.disabled = true;
            const textoOriginal = btnRegistrar.textContent;
            btnRegistrar.textContent = 'Procesando...';

            try {
                const { data: sessionData, error: sessionError } = await db.auth.getSession();
                if (sessionError) throw sessionError;
                
                const session = sessionData?.session;
                
                if (session && session.user && session.user.is_anonymous) {
                    const { error: updateError } = await db.auth.updateUser({ email, password });
                    if (updateError) throw updateError;
                    mostrarToast('¡Progreso guardado! Tu cuenta oficial está lista.');
                    passwordInput.value = '';
                    verificarEstadoSesion();
                } else {
                    const { data: signUpData, error: signUpError } = await db.auth.signUp({ email, password });
                    if (signUpError) throw signUpError;
                    mostrarToast('¡Cuenta creada con éxito!');
                    passwordInput.value = '';
                    actualizarUIIngreso(signUpData?.session || null);
                    cargarEstadisticas();
                    cargarPlanes();
                }
            } catch (err) {
                mostrarToast('Error en el registro: ' + err.message, 'error');
            } finally {
                if (btnRegistrar) {
                    btnRegistrar.disabled = false;
                    btnRegistrar.textContent = textoOriginal;
                }
            }
        });

        document.getElementById('btn-cerrar-sesion')?.addEventListener('click', async () => {
            try {
                const { error: signOutError } = await db.auth.signOut();
                if (signOutError) throw signOutError;
                
                // [CISO] Purga absoluta de memoria volátil cross-tenant para evitar resurrección de datos
                localStorage.removeItem('categorias_cache');
                localStorage.removeItem('categorias_eliminadas_ids');
                localStorage.removeItem('transacciones_cache_dia');
                localStorage.removeItem('transacciones_cache_mes');
                localStorage.removeItem('transacciones_cache_anio');
                transaccionesCacheActuales = [];
                
                mostrarToast('Sesión cerrada correctamente');
                actualizarUIIngreso(null);
                cargarEstadisticas();
                cargarPlanes();
            } catch (err) {
                mostrarToast('Error al cerrar sesión', 'error');
            }
        });

        // Null Guard condicional para prevenir bloqueos de renderizado ante caídas del CDN de Supabase
        if (db && db.auth) {
            db.auth.onAuthStateChange((event, session) => {
                actualizarUIIngreso(session);
            });
        }

        function verificarSeguridadBiometrico() {
            const biomHabilitado = localStorage.getItem('biometrico_activo');
            if (biomHabilitado === 'true') {
                const modalBiometrico = document.getElementById('modal-biometrico');
                if (modalBiometrico) {
                    modalBiometrico.classList.remove('hidden');
                    modalBiometrico.classList.add('flex');
                }
            }
        }

        let tipoAdminActivo = 'gasto';

        // [NUEVO] Delegación de Eventos Estática (Cero Fugas de Memoria V8)
        document.getElementById('lista-categorias-admin')?.addEventListener('click', (e) => {
            const btnEdit = e.target.closest('.btn-edit-admin');
            const btnDel = e.target.closest('.btn-del-admin');
            
            if (btnEdit) {
                const catId = btnEdit.getAttribute('data-id');
                let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                const cat = categorias.find(c => c.id === catId);
                if (cat) abrirModalEditarCategoria(cat);
            }
            
            if (btnDel) {
                const catId = btnDel.getAttribute('data-id');
                let idsEliminadas = JSON.parse(localStorage.getItem('categorias_eliminadas_ids') || '[]');
                if (!idsEliminadas.includes(catId)) {
                    idsEliminadas.push(catId);
                    localStorage.setItem('categorias_eliminadas_ids', JSON.stringify(idsEliminadas));
                    abrirModalGestionarCategorias(); // Forzar re-render para ocultar visualmente
                    mostrarToast('Marcada para eliminar. Confirma para guardar.');
                }
            }
        });

        // [NUEVO] Despachador de Transacciones (Batch Commit)
        const btnGuardarAdmin = document.getElementById('btn-guardar-admin-cat');
        if (btnGuardarAdmin) {
            // Clonamos para destruir posibles listeners previos (Zero-Leak Barrier)
            const nuevoBtnGuardarAdmin = btnGuardarAdmin.cloneNode(true);
            btnGuardarAdmin.parentNode.replaceChild(nuevoBtnGuardarAdmin, btnGuardarAdmin);
            
            nuevoBtnGuardarAdmin?.addEventListener('click', async (e) => {
                const btn = e.target;
                btn.disabled = true;
                btn.textContent = 'Guardando en la nube...';

                const { data: { session } } = await db.auth.getSession();
                let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                let idsEliminadas = JSON.parse(localStorage.getItem('categorias_eliminadas_ids') || '[]');

                if (session && navigator.onLine) {
                    try {
                        for (let id of idsEliminadas) {
                            const esForanea = id.startsWith('fallback') || typeof id !== 'string' || id.length < 15;
                            if (!esForanea) {
                                const { error: delCatError } = await db.from('categorias').delete().eq('id', id).eq('user_id', session.user.id);
                                if (delCatError) throw new Error(`Fallo RLS al borrar: ${delCatError.message}`);
                            }
                        }
                        
                        const editadas = categorias.filter(c => c._editado);
                        for (let cat of editadas) {
                            const payload = { nombre: cat.nombre, icono: cat.icono, es_fijo: cat.es_fijo };
                            if (!cat.user_id) {
                                const { data: catData, error: catErr } = await db.from('categorias').insert([{...payload, tipo: cat.tipo, user_id: session.user.id}]).select();
                                if (catErr) throw new Error(`Fallo inserción: ${catErr.message}`);
                                if (catData && catData.length > 0) cat.id = catData[0].id;
                            } else {
                                const { error: upErr } = await db.from('categorias').update(payload).eq('id', cat.id).eq('user_id', session.user.id);
                                if (upErr) throw new Error(`Fallo actualización: ${upErr.message}`);
                            }
                        }

                        // Consolidación Atómica: Solo se ejecuta si NINGUNA operación a la API falló
                        categorias = categorias.filter(c => !idsEliminadas.includes(c.id));
                        categorias = categorias.map(c => { delete c._editado; return c; });
                        localStorage.setItem('categorias_cache', JSON.stringify(categorias));
                        localStorage.removeItem('categorias_eliminadas_ids');

                        btn.classList.add('hidden');
                        btn.disabled = false;
                        btn.textContent = '💾 Confirmar y Guardar Cambios';
                        
                        renderizarCategoriasFlujo();
                        abrirModalGestionarCategorias();
                        mostrarToast('Categorías sincronizadas con éxito.');
                    } catch (errorTransaccion) {
                        console.error('[CISO Audit] Rollback Transaccional UI:', errorTransaccion);
                        mostrarToast(errorTransaccion.message, 'error');
                        btn.disabled = false;
                        btn.textContent = '💾 Reintentar Guardado (Fallo de Red/Permisos)';
                        return; // Abortamos la destrucción del caché para evitar desincronización
                    }
                } else {
                    mostrarToast('Sin conexión válida con Supabase', 'error');
                    btn.disabled = false;
                    btn.textContent = '💾 Confirmar y Guardar Cambios';
                }
            });
        }

        function abrirModalGestionarCategorias() {
            const contenedor = document.getElementById('lista-categorias-admin');
            contenedor.textContent = '';
            let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
            let idsEliminadas = JSON.parse(localStorage.getItem('categorias_eliminadas_ids') || '[]');
            
            // Oculta en tiempo real las marcadas para eliminación local
            categorias = categorias.filter(c => !idsEliminadas.includes(c.id));
            const catsFiltradas = categorias.filter(c => c.tipo === tipoAdminActivo);

            if (catsFiltradas.length === 0) {
                contenedor.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">No hay categorías en esta sección.</p>';
            } else {
                catsFiltradas.forEach(cat => {
                    const isEditado = cat._editado ? '<span class="ml-2 text-[9px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full">Pendiente</span>' : '';
                    const item = document.createElement('div');
                    item.className = "flex items-center justify-between p-3 bg-slate-950 rounded-2xl border border-slate-800";
                    item.innerHTML = `
                        <div class="flex items-center gap-3">
                            <span class="text-xl">${escapeHTML(cat.icono)}</span>
                            <div>
                                <div class="flex items-center">
                                    <span class="text-xs font-bold text-white block">${escapeHTML(cat.nombre)}</span>
                                    ${isEditado}
                                </div>
                                <span class="text-[10px] text-slate-400 uppercase">${cat.tipo} ${cat.es_fijo ? '• Fijo / Factura' : ''}</span>
                            </div>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <button type="button" data-id="${cat?.id}" class="btn-edit-admin px-2.5 py-1.5 rounded-xl bg-slate-800 text-emerald-400 text-xs font-bold active:scale-95 cursor-pointer">✏️</button>
                            <button type="button" data-id="${cat?.id}" class="btn-del-admin px-2.5 py-1.5 rounded-xl bg-red-500/10 text-red-400 text-xs font-bold active:scale-95 cursor-pointer">🗑️</button>
                        </div>
                    `;
                    contenedor.appendChild(item);
                });
            }

            document.getElementById('modal-gestionar-categorias')?.classList.remove('hidden');
            document.getElementById('modal-gestionar-categorias')?.classList.add('flex');
            
            // Lógica de visibilidad del despachador final
            const hasPendingEdits = categorias.some(c => c._editado);
            if (idsEliminadas.length > 0 || hasPendingEdits) {
                document.getElementById('btn-guardar-admin-cat')?.classList.remove('hidden');
            } else {
                document.getElementById('btn-guardar-admin-cat')?.classList.add('hidden');
            }
        }

        const tabAdminGastos = document.getElementById('tab-admin-gastos');
        const tabAdminIngresos = document.getElementById('tab-admin-ingresos');

        if (tabAdminGastos && tabAdminIngresos) {
            tabAdminGastos?.addEventListener('click', () => {
                tipoAdminActivo = 'gasto';
                tabAdminGastos.className = "py-2.5 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950 transition-all cursor-pointer";
                tabAdminIngresos.className = "py-2.5 rounded-xl text-xs font-bold bg-slate-800 text-slate-400 transition-all cursor-pointer";
                abrirModalGestionarCategorias();
            });

            tabAdminIngresos?.addEventListener('click', () => {
                tipoAdminActivo = 'ingreso';
                tabAdminIngresos.className = "py-2.5 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950 transition-all cursor-pointer";
                tabAdminGastos.className = "py-2.5 rounded-xl text-xs font-bold bg-slate-800 text-slate-400 transition-all cursor-pointer";
                abrirModalGestionarCategorias();
            });
        }

        document.getElementById('btn-abrir-gestionar-cat')?.addEventListener('click', abrirModalGestionarCategorias);
        document.getElementById('btn-cerrar-gestionar-cat')?.addEventListener('click', () => {
            document.getElementById('modal-gestionar-categorias')?.classList.add('hidden');
            document.getElementById('modal-gestionar-categorias')?.classList.remove('flex');
        });
        document.getElementById('btn-nueva-desde-admin')?.addEventListener('click', () => {
            document.getElementById('modal-gestionar-categorias')?.classList.add('hidden');
            document.getElementById('modal-gestionar-categorias')?.classList.remove('flex');
            abrirModalNuevaCategoria();
        });

        document.getElementById('btn-desbloquear')?.addEventListener('click', async () => {
            try {
                // Forzamos al navegador a pedir verificación local (huella, pin, face id) si está disponible
                if (window.PublicKeyCredential) {
                    const challenge = new Uint8Array(32);
                    window.crypto.getRandomValues(challenge);
                    
                    await navigator.credentials.get({
                        publicKey: {
                            challenge: challenge,
                            rpId: window.location.hostname !== 'localhost' ? window.location.hostname : undefined,
                            userVerification: "required"
                        }
                    });
                }
                
                document.getElementById('modal-biometrico')?.classList.add('hidden');
                document.getElementById('modal-biometrico')?.classList.remove('flex');
                mostrarToast('Identidad confirmada');
            } catch (err) {
                mostrarToast('Autenticación fallida o cancelada. Acceso denegado.', 'error');
            }
        });

        function cerrarModalRollover() {
            document.getElementById('modal-rollover')?.classList.add('hidden');
            document.getElementById('modal-rollover')?.classList.remove('flex');
        }

        async function comprobarRolloverMes() {
            let ahora = new Date();
            
            // Mitigación Zero-Trust: Validar tiempo contra servidor para evitar manipulación de reloj local
            if (navigator.onLine) {
                try {
                    // Hacemos un ping a nuestro propio dominio (Vercel) para leer la hora oficial del servidor.
                    // Esto evita depender de APIs de terceros que se caen (ERR_CONNECTION_RESET).
                    const res = await fetch(window.location.origin, { method: 'HEAD', cache: 'no-store' });
                    const fechaServidor = res.headers.get('date');
                    if (fechaServidor) {
                        ahora = new Date(fechaServidor);
                    }
                } catch (e) {
                    // Fallback silencioso al reloj local si falla la red
                }
            }

            const periodoActual = `${ahora.getFullYear()}-${ahora.getMonth()}`;
            const periodoGuardado = localStorage.getItem('mes_actual_registro');
            
            if (periodoGuardado && periodoGuardado !== periodoActual) {
                if (ultimoBalanceCalculado > 0) {
                    const elTexto = document.getElementById('texto-rollover');
                    const elModal = document.getElementById('modal-rollover');
                    if (elTexto) elTexto.textContent = `Tienes un saldo restante de ${formatearMoneda(ultimoBalanceCalculado)} del mes anterior. ¿Qué deseas hacer con este dinero?`;
                    if (elModal) {
                        elModal.classList.remove('hidden');
                        elModal.classList.add('flex');
                    }
                }

                try {
                    const { data, error: errSession } = await db.auth.getSession();
                    if (errSession) throw errSession;
                    
                    const session = data?.session;
                    if (session) {
                        const { data: planes, error: errPlanes } = await db.from('planes')
                            .select('*')
                            .eq('user_id', session.user.id)
                            .eq('tipo', 'limite')
                            .eq('auto_renovar', true);
                        if (errPlanes) throw errPlanes;
                        
                        if (planes && planes.length > 0) {
                            mostrarToast(`📅 Nuevo mes detectado: Tienes ${planes.length} límites fijos listos para el ciclo.`);
                        }
                    }
                } catch (errorSupabase) {
                    console.warn('[CISO Alert] Pausa de validación en rollover por red:', errorSupabase.message);
                }
            }
            localStorage.setItem('mes_actual_registro', periodoActual);
        }

        const btnAhorroExpres = document.getElementById('btn-ahorro-expres');
        if (btnAhorroExpres) {
            btnAhorroExpres?.addEventListener('click', async () => {
                const valMonto = parseInt(monto);
                if (isNaN(valMonto) || valMonto <= 0) {
                    mostrarToast('Digita primero el monto en pantalla para apartar como ahorro', 'error');
                    return;
                }

                const { data: { session } } = await db.auth.getSession();
                if (!session) {
                    mostrarToast('Inicia sesión para usar el ahorro exprés', 'error');
                    return;
                }

                const { data: metas, error: errMetas } = await db.from('planes')
                    .select('*')
                    .eq('tipo', 'meta')
                    .eq('user_id', session.user.id);

                const metaEmergencia = (metas || []).find(p => p.es_fondo_emergencia) || (metas || [])[0];

                if (!metaEmergencia) {
                    mostrarToast('Crea primero una Meta o Fondo de Emergencia en la pestaña Planes', 'error');
                    cambiarTab('planes');
                    return;
                }

                const nuevoAcumulado = parseFloat(metaEmergencia.monto_acumulado || 0) + valMonto;
                const { error: errUp } = await db.from('planes').update({ monto_acumulado: nuevoAcumulado }).eq('id', metaEmergencia?.id);

                if (!errUp) {
                    mostrarToast(`⚡ ¡${formatearMoneda(valMonto)} guardados en "${metaEmergencia.titulo}"!`);
                    limpiar();
                    cargarPlanes();
                    cargarEstadisticas();
                } else {
                    mostrarToast('Error al procesar ahorro: ' + errUp.message, 'error');
                }
            });
        }

        const btnCerrarRollover = document.getElementById('btn-cerrar-rollover');
        if (btnCerrarRollover) btnCerrarRollover?.addEventListener('click', cerrarModalRollover);

        const btnOmitirRollover = document.getElementById('btn-rollover-omitir');
        if (btnOmitirRollover) btnOmitirRollover?.addEventListener('click', cerrarModalRollover);

        document.getElementById('btn-rollover-ahorro')?.addEventListener('click', async () => {
            try {
                const { data, error: errSession } = await db.auth.getSession();
                if (errSession) throw errSession;
                
                const session = data?.session;
                if (session && ultimoBalanceCalculado > 0) {
                    const { error: insErr } = await db.from('planes').insert([{ 
                        tipo: 'meta', 
                        monto: ultimoBalanceCalculado, 
                        monto_acumulado: ultimoBalanceCalculado,
                        titulo: 'Rollover Fondo de Emergencia', 
                        user_id: session.user.id 
                    }]);
                    if (insErr) throw insErr;
                    cargarPlanes();
                }
                cerrarModalRollover();
                mostrarToast('Saldo trasladado a Ahorro');
            } catch (error) {
                console.error('[CISO Security] Bloqueo en ejecución Rollover:', error.message);
                mostrarToast('Error de conexión. Operación cancelada.', 'error');
            }
        });

        document.getElementById('btn-rollover-colchon')?.addEventListener('click', () => {
            cerrarModalRollover();
            mostrarToast('Saldo mantenido como colchón');
        });

        document.getElementById('btn-exportar-json')?.addEventListener('click', async () => {
            const { data: { session } } = await db.auth.getSession();
            if (!session) {
                mostrarToast('Inicia sesión para exportar tus datos', 'error');
                return;
            }
            const { data: trans, error: errTrans } = await db.from('transacciones').select('*').eq('user_id', session.user.id);
            const { data: plans, error: errPlans } = await db.from('planes').select('*').eq('user_id', session.user.id);
            const backup = { transacciones: trans || [], planes: plans || [], fechaExportacion: new Date().toISOString() };
            
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `respaldo-mis-gastos-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            mostrarToast('Respaldo JSON descargado con éxito');
        });

        const btnExportCsv = document.getElementById('btn-exportar-csv');
        if (btnExportCsv) {
            btnExportCsv?.addEventListener('click', async () => {
                const { data: { session } } = await db.auth.getSession();
                if (!session) {
                    mostrarToast('Inicia sesión para exportar tus datos', 'error');
                    return;
                }
                const { data: trans, error: errTrans } = await db.from('transacciones').select('*').eq('user_id', session.user.id).order('fecha', { ascending: false });
                if (!trans || trans.length === 0) {
                    mostrarToast('No hay transacciones para exportar', 'error');
                    return;
                }

                let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                const mapaCat = {};
                categorias.forEach(c => { mapaCat[c.id] = c; });

                let csvContent = '\uFEFF'; 
                csvContent += 'ID;Fecha;Tipo;Categoria;Subtipo;Cuenta;Monto;Notas\r\n';

                trans.forEach(t => {
                    const cat = mapaCat[t.categoria_id] || { nombre: 'Sin categoría', tipo: 'gasto', es_fijo: false };
                    const fechaFormateada = t.fecha ? t.fecha.slice(0, 10) : '';
                    const tipoMov = cat.tipo === 'ingreso' ? 'Ingreso' : 'Gasto';
                    const subtipo = cat.es_fijo ? 'Fijo / Factura' : 'Variable';
                    const notasLimpias = (t.notas || '').replace(/;/g, ',').replace(/\n/g, ' ');
                    
                    csvContent += `"${t.id}";"${fechaFormateada}";"${tipoMov}";"${cat.nombre}";"${subtipo}";"${t.cuenta || ''}";${t.monto};"${notasLimpias}"\r\n`;
                });

                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `libro-diario-gastos-${new Date().toISOString().slice(0,10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
                mostrarToast('Archivo CSV generado para Excel');
            });
        }

        const btnExportPdf = document.getElementById('btn-exportar-pdf');
        if (btnExportPdf) {
            btnExportPdf?.addEventListener('click', () => {
                window.print();
            });
        }

        document.getElementById('btn-copiar-atajo')?.addEventListener('click', () => {
            navigator.clipboard.writeText(window.location.href);
            const btnCopiar = document.getElementById('btn-copiar-texto');
            if (btnCopiar) btnCopiar.textContent = '¡Enlace copiado al portapapeles!';
            setTimeout(() => {
                const btnCopiar2 = document.getElementById('btn-copiar-texto');
                if (btnCopiar2) btnCopiar2.textContent = 'Copiar Enlace para iOS';
            }, 2500);
            mostrarToast('Enlace listo para tu atajo');
        });

        const btnPriv = document.getElementById('btn-privacidad');
        if (btnPriv) btnPriv.textContent = modoPrivacidad ? '🔒' : '👁️';

        btnPriv?.addEventListener('click', () => {
            modoPrivacidad = !modoPrivacidad;
            localStorage.setItem('modo_privacidad_gastos', modoPrivacidad);
            const btnPriv2 = document.getElementById('btn-privacidad');
            if (btnPriv2) btnPriv2.textContent = modoPrivacidad ? '🔒' : '👁️';
            actualizarPantalla();
            if (!document.getElementById('pantalla-dashboard')?.classList.contains('hidden')) {
                cargarEstadisticas();
            }
            if (navigator.vibrate) navigator.vibrate(20);
        });

        const mesActualIndex = new Date().getMonth();
        const selMes = document.getElementById('selector-mes-excel');
        if (selMes) selMes.value = mesActualIndex;
        selMes?.addEventListener('change', cargarEstadisticas);

        let monto = '0';
let expresionCalculadora = '';
let graficoInstancia = null;

        document.querySelectorAll('.op-btn').forEach(btn => {
            btn?.addEventListener('click', (e) => {
                const op = e.target.getAttribute('data-op');
                if (monto !== '0') {
                    expresionCalculadora += monto + ' ' + op + ' ';
                    monto = '0';
                    actualizarPantalla();
                }
            });
        });

        function calcularExpresionSegura(expr) {
            try {
                const tokens = expr.trim().split(/\s+/);
                if (tokens.length === 0) return 0;
                let acumulado = parseFloat(tokens[0]);
                
                if (isNaN(acumulado)) return 0;

                for (let i = 1; i < tokens.length; i += 2) {
                    const operador = tokens[i];
                    const siguienteNum = parseFloat(tokens[i + 1]);
                    
                    if (isNaN(siguienteNum)) continue; 
                    
                    if (operador === '+') acumulado += siguienteNum;
                    else if (operador === '-') acumulado -= siguienteNum;
                }
                
                // Evitamos estados NaN o Infinity que corrompan el balance general
                return (isFinite(acumulado) && !isNaN(acumulado)) ? Math.max(0, acumulado) : 0;
            } catch (err) {
                return 0; // Cero absoluto, nunca NaN
            }
        }

        const btnIgual = document.getElementById('btn-igual');
        if (btnIgual) {
            btnIgual?.addEventListener('click', () => {
                if (expresionCalculadora) {
                    const expresionFinal = expresionCalculadora + monto;
                    const resultado = calcularExpresionSegura(expresionFinal);
                    if (!isNaN(resultado)) {
                        monto = String(Math.max(0, Math.round(resultado)));
                        expresionCalculadora = '';
                        actualizarPantalla();
                    } else {
                        mostrarToast('Operación inválida', 'error');
                        expresionCalculadora = '';
                    }
                }
            });
        }

        let categoriaPendiente = null;
        let tipoActual = 'gasto';
        let tipoSubCatActual = 'variable';
        let tipoPlanActivo = '';
        
        const listaCuentas = ['Efectivo', 'Bancos', 'Tarjetas', 'Transferencia'];
        let cuentaGuardada = localStorage.getItem('cuenta_mis_gastos');
        let cuentaIndex = listaCuentas.includes(cuentaGuardada) ? listaCuentas.indexOf(cuentaGuardada) : 0;
        let cuentaActual = listaCuentas[cuentaIndex];
        const btnCta = document.getElementById('btn-cuenta');
        if (btnCta) btnCta.textContent = cuentaActual;

        const elFecha = document.getElementById('fecha-actual');
        if (elFecha) elFecha.textContent = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'short' }).format(new Date());

        function mostrarToast(mensaje, tipo = 'exito') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            const bgColor = tipo === 'exito' ? 'bg-emerald-500 text-slate-950' : 'bg-red-500 text-white';
            toast.className = `${bgColor} px-4 py-3 rounded-2xl font-bold text-xs shadow-xl pointer-events-auto transform translate-y-2 opacity-0 transition-all duration-300 flex items-center justify-between`;
            toast.innerHTML = `<span>${escapeHTML(mensaje)}</span>`;
            container.appendChild(toast);
            setTimeout(() => toast.classList.remove('translate-y-2', 'opacity-0'), 10);
            setTimeout(() => {
                toast.classList.add('translate-y-2', 'opacity-0');
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }

        // [PERFORMANCE] Registro único y seguro del plugin de texto central
        const centerTextPlugin = {
            id: 'centerText',
            beforeDraw: function(chart) {
                if (chart.config.type !== 'doughnut' || !chart.config.options.plugins?.centerText) return;
                let width = chart.width, height = chart.height, ctx = chart.ctx;
                ctx.save();
                let text = chart.config.options.plugins.centerText.text || "$ 0";
                ctx.font = "bold 1.2rem sans-serif";
                ctx.textBaseline = "middle";
                ctx.fillStyle = "#ffffff";
                let textX = Math.round((width - ctx.measureText(text).width) / 2);
                let textY = height / 2 - 5;
                ctx.fillText(text, textX, textY);
                let subText = "gastado";
                ctx.font = "normal 0.75rem sans-serif";
                ctx.fillStyle = "#94a3b8";
                let subTextX = Math.round((width - ctx.measureText(subText).width) / 2);
                ctx.fillText(subText, subTextX, textY + 20);
                ctx.restore();
            }
        };
        
        // Evitar registro duplicado si la vista se recarga sin purgar memoria
        if (typeof Chart !== 'undefined' && !Chart.registry.plugins.get('centerText')) {
            Chart.register(centerTextPlugin);
        }

        document.getElementById('btn-cuenta')?.addEventListener('click', () => {
            cuentaIndex = (cuentaIndex + 1) % listaCuentas.length;
            cuentaActual = listaCuentas[cuentaIndex];
            localStorage.setItem('cuenta_mis_gastos', cuentaActual);
            const btnCuenta = document.getElementById('btn-cuenta');
if (btnCuenta) {
    btnCuenta.textContent = cuentaActual;
}
            if (navigator.vibrate) navigator.vibrate(20);
        });

        function actualizarPantalla() { 
            const mDisp = document.getElementById('monto-display');
            if (mDisp) mDisp.textContent = formatearMoneda(parseInt(monto || '0')); 
        }

        document.querySelectorAll('.num-btn').forEach(btn => {
            btn?.addEventListener('click', (e) => {
                const num = e.target.getAttribute('data-num');
                if (monto === '0' || monto === 0) monto = num; 
                else if (monto.length < 10) monto += num; 
                actualizarPantalla();
                if (navigator.vibrate) navigator.vibrate(15);
            });
        });

        document.getElementById('btn-borrar')?.addEventListener('click', () => { 
            monto = monto.slice(0, -1); 
            if (monto === '') monto = '0'; 
            actualizarPantalla(); 
            if (navigator.vibrate) navigator.vibrate(15);
        });

        document.getElementById('btn-limpiar')?.addEventListener('click', () => { 
            monto = '0'; 
            actualizarPantalla(); 
            if (navigator.vibrate) navigator.vibrate(15);
        });

        let iconoNuevaCatSeleccionado = '🍿';
        let tipoNuevaCatEsFijo = false;
        // Diccionario Unicode Nativo Segmentado (Zero-Tofu Rendering en PWA OSs)
        const listaEmojisPopulares = [
            '🍔', '🛒', '☕', '🍺', '🍿', '🥩', '🥑', '🍕', '🥖', '🥦', '🍓', '🍷', '🥗', // Alimentos & Ocio
            '🚗', '⛽', '🚌', '🚕', '✈️', '🚂', '🛳️', '🚴', '🏍️', '🛵', // Transporte
            '🏠', '💡', '💧', '🔌', '🚿', '🛁', '🧹', '🧺', '🧼', '🧻', '🧴', // Hogar & Servicios
            '👕', '👗', '👟', '👔', '🎒', '💄', '💍', '👓', // Compras & Moda
            '💊', '🩺', '🌡️', '🏋️', '💈', '🧘', '🏥', '🦷', // Salud & Cuidado
            '🎮', '🎬', '🎟️', '🎧', '📚', '🎨', '🏖️', '⛺', '🧸', // Entretenimiento
            '🐶', '🐈', '🐾', '🪴', '💐', // Mascotas & Vida
            '📱', '💻', '📺', '🔧', '🛠️', '⚙️', '🔋', // Tecnología
            '🏦', '💳', '💰', '📉', '📈', '🧾', '🎁', '🏫', '🎓', '🚀' // Finanzas & Metas
        ];

        function iniciarCaptura() {
            if(parseInt(monto) === 0) {
                mostrarToast('Digita un valor mayor a cero.', 'error');
                return;
            }
            // Estado base garantizado al abrir
            tipoActual = 'gasto';
            tipoSubCatActual = 'variable';
            const inputBuscar = document.getElementById('input-buscar-categoria');
            if (inputBuscar) inputBuscar.value = '';
            
            const flMonto = document.getElementById('flujo-monto-display');
            if (flMonto) flMonto.textContent = formatearMoneda(parseInt(monto));
            
            document.getElementById('modal-flujo')?.classList.remove('hidden');
            document.getElementById('modal-flujo')?.classList.add('flex');
            document.getElementById('flujo-paso-1')?.classList.remove('hidden');
            document.getElementById('flujo-paso-1')?.classList.add('flex');
            document.getElementById('flujo-paso-2')?.classList.add('hidden');
            document.getElementById('flujo-paso-2')?.classList.remove('flex');
        }

        document.getElementById('btn-siguiente')?.addEventListener('click', iniciarCaptura);

        function cerrarFlujo() {
            document.getElementById('modal-flujo')?.classList.add('hidden');
            document.getElementById('modal-flujo')?.classList.remove('flex');
            // Restaurar visualmente los botones de filtro a su estado por defecto de forma segura
            const fCatVar = document.getElementById('filtro-cat-variable');
            if (fCatVar) fCatVar.className = "py-2 px-3 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold transition-all cursor-pointer";
            const fCatFijo = document.getElementById('filtro-cat-fijo');
            if (fCatFijo) fCatFijo.className = "py-2 px-3 rounded-xl bg-slate-800 border border-slate-700 text-slate-400 text-xs font-bold transition-all cursor-pointer";
        }

        document.getElementById('btn-cerrar-flujo')?.addEventListener('click', cerrarFlujo);
        document.getElementById('btn-retroceder-flujo')?.addEventListener('click', () => {
            document.getElementById('flujo-paso-2')?.classList.add('hidden');
            document.getElementById('flujo-paso-2')?.classList.remove('flex');
            document.getElementById('flujo-paso-1')?.classList.remove('hidden');
            document.getElementById('flujo-paso-1')?.classList.add('flex');
        });

        document.getElementById('btn-tipo-gasto')?.addEventListener('click', () => avanzarFlujo('gasto'));
        document.getElementById('btn-tipo-ingreso')?.addEventListener('click', () => avanzarFlujo('ingreso'));
        document.getElementById('btn-tipo-meta')?.addEventListener('click', () => avanzarFlujo('meta'));
        document.getElementById('btn-tipo-deuda')?.addEventListener('click', () => avanzarFlujo('deuda'));

        document.getElementById('filtro-cat-variable')?.addEventListener('click', () => {
            tipoSubCatActual = 'variable';
            document.getElementById('filtro-cat-variable').className = "py-2.5 px-3 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold transition-all cursor-pointer";
            document.getElementById('filtro-cat-fijo').className = "py-2.5 px-3 rounded-xl bg-slate-800 border border-slate-700 text-slate-400 text-xs font-bold transition-all cursor-pointer";
            renderizarCategoriasFlujo();
        });

        document.getElementById('filtro-cat-fijo')?.addEventListener('click', () => {
            tipoSubCatActual = 'fijo';
            document.getElementById('filtro-cat-fijo').className = "py-2.5 px-3 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold transition-all cursor-pointer";
            document.getElementById('filtro-cat-variable').className = "py-2.5 px-3 rounded-xl bg-slate-800 border border-slate-700 text-slate-400 text-xs font-bold transition-all cursor-pointer";
            renderizarCategoriasFlujo();
        });

        function avanzarFlujo(tipo) {
            tipoActual = tipo;
            const seccionFiltros = document.getElementById('seccion-filtros-cat');
            const label = document.getElementById('flujo-tipo-label');

            if (tipo === 'gasto') {
                if (seccionFiltros) seccionFiltros.classList.remove('hidden');
                if (label) label.textContent = '📉 Registrando Gasto / Factura';
            } else if (tipo === 'ingreso') {
                if (seccionFiltros) seccionFiltros.classList.add('hidden');
                if (label) label.textContent = '📈 Registrando Ingreso';
            } else if (tipo === 'meta') {
                if (seccionFiltros) seccionFiltros.classList.add('hidden');
                if (label) label.textContent = '🎯 Aportar a Meta de Ahorro';
            } else if (tipo === 'deuda') {
                if (seccionFiltros) seccionFiltros.classList.add('hidden');
                if (label) label.textContent = '💳 Abonar a Crédito / Deuda';
            }

            document.getElementById('flujo-paso-1')?.classList.add('hidden');
            document.getElementById('flujo-paso-1')?.classList.remove('flex');
            document.getElementById('flujo-paso-2')?.classList.remove('hidden');
            document.getElementById('flujo-paso-2')?.classList.add('flex');
            renderizarCategoriasFlujo();
        }

        async function sincronizarCategoriasCache() {
            try {
                if (navigator.onLine && db && db.auth) {
                    const { data: { session } } = await db.auth.getSession();
                    // Solo traemos categorías globales (user_id IS NULL) o del usuario actual
                    let query = db.from('categorias').select('*').order('nombre');
                    if (session) {
                        query = query.or(`user_id.is.null,user_id.eq.${session.user.id}`);
                    } else {
                        query = query.is('user_id', null);
                    }
                    
                    const { data: queryData, error: queryError } = await query;
                    
                    if (!queryError && queryData) {
                        let idsEliminadas = JSON.parse(localStorage.getItem('categorias_eliminadas_ids') || '[]');
                        
                        // [INYECCIÓN] Deduplicación asimétrica para bloquear duplicados en dispositivos nuevos
                        const mapaUnicas = new Map();
                        [...queryData]
                            .sort((a, b) => (b.user_id ? 1 : 0) - (a.user_id ? 1 : 0)) // Prioridad a categoría de usuario
                            .forEach(c => {
                                const hash = c.nombre.toLowerCase().trim();
                                if (!mapaUnicas.has(hash)) mapaUnicas.set(hash, c);
                            });
                        const categoriasDeduplicadas = Array.from(mapaUnicas.values());

                        const categoriasFiltradas = categoriasDeduplicadas.filter(c => !idsEliminadas.includes(c.id));
                        localStorage.setItem('categorias_cache', JSON.stringify(categoriasFiltradas));
                    }
                }
            } catch (err) {
                console.warn('Sincronización de categorías omitida por estado offline o error.');
            }
        }

        async function renderizarCategoriasFlujo() {
            const contenedor = document.getElementById('flujo-categorias-container');
            contenedor.textContent = '';
            const { data: { session } } = await db.auth.getSession();

            if (tipoActual === 'meta' || tipoActual === 'deuda') {
                if (!session) {
                    contenedor.innerHTML = '<p class="col-span-3 text-center text-xs text-slate-500 py-6">Inicia sesión para gestionar metas y deudas.</p>';
                    return;
                }
                const { data: planes, error: errPlanes } = await db.from('planes')
                    .select('*')
                    .eq('tipo', tipoActual)
                    .eq('user_id', session.user.id)
                    .eq('mostrar_en_inicio', true);

                if (!planes || planes.length === 0) {
                    contenedor.innerHTML = `<p class="col-span-3 text-center text-xs text-slate-500 py-6">No tienes ${tipoActual === 'meta' ? 'metas' : 'deudas'} marcadas para inicio. Actívalas en la pestaña Planes.</p>`;
                    return;
                }

                planes.forEach(plan => {
                    const btn = document.createElement('button');
                    btn.type = "button";
                    btn.className = "col-span-3 flex items-center justify-between p-4 bg-slate-800 rounded-2xl active:bg-slate-700 active:scale-[0.98] border border-slate-700 shadow-md text-left transition-all cursor-pointer";
                    const icono = tipoActual === 'meta' ? '🎯' : '💳';
                    let infoSubtexto = '';
                    if (tipoActual === 'meta') {
                        const acum = parseFloat(plan.monto_acumulado || 0);
                        const obj = parseFloat(plan.monto);
                        const pct = obj > 0 ? Math.round((acum / obj) * 100) : 0;
                        infoSubtexto = `${formatearMoneda(acum)} / ${formatearMoneda(obj)} (${pct}%)`;
                    } else {
                        const total = parseFloat(plan.monto);
                        const pagado = parseFloat(plan.monto_acumulado || 0);
                        const resta = Math.max(0, total - pagado);
                        infoSubtexto = `Resta: ${formatearMoneda(resta)}`;
                    }

                    btn.textContent = `
                        <div class="flex items-center gap-3">
                            <span class="text-2xl">${icono}</span>
                            <div>
                                <span class="text-sm font-bold text-white block">${escapeHTML(plan.titulo)}</span>
                                <span class="text-xs text-slate-400 block">${infoSubtexto}</span>
                            </div>
                        </div>
                        <span class="text-xs font-bold text-emerald-400">Abonar +</span>
                    `;
                    btn?.addEventListener('click', () => {
                        if (tipoActual === 'meta') aplicarAporteMeta(plan);
                        else aplicarAbonoDeuda(plan);
                    });
                    contenedor.appendChild(btn);
                });
                return;
            }

            let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
            let idsEliminadas = JSON.parse(localStorage.getItem('categorias_eliminadas_ids') || '[]');
            
            categorias = categorias.filter(c => !idsEliminadas.includes(c.id));

            if (navigator.onLine && categorias.length === 0) {
                const { data, error: errCat } = await db.from('categorias').select('*').order('nombre');
                if (data) { 
                    categorias = data.filter(c => !idsEliminadas.includes(c.id)); 
                    localStorage.setItem('categorias_cache', JSON.stringify(categorias)); 
                }
            }
            
            const catsFiltradas = categorias.filter(c => {
                if (c.tipo !== tipoActual) return false;
                if (tipoActual === 'gasto') {
                    const isFijo = c.es_fijo || ['ARRIENDO', 'SERVICIOS', 'SUSCRIPCIONES', 'MADRE', 'FACTURAS'].some(k => c.nombre.toUpperCase().includes(k));
                    if (tipoSubCatActual === 'fijo' && !isFijo) return false;
                    if (tipoSubCatActual === 'variable' && isFijo) return false;
                }
                return true;
            });
            
            const fragmentoCategorias = document.createDocumentFragment();

            catsFiltradas.forEach(cat => {
                const wrapper = document.createElement('div');
                wrapper.className = "relative flex flex-col";

                const btn = document.createElement('button');
                btn.type = "button";
                // Clase trazadora y variables inmutables en data attributes
                btn.className = "btn-flujo-cat flex-1 flex flex-col items-center justify-center p-3 bg-slate-800 rounded-2xl active:bg-emerald-600 active:scale-95 transition-all border border-slate-700 shadow-md min-h-[85px] cursor-pointer";
                btn.dataset.catid = escapeHTML(cat.id);
                btn.dataset.catnombre = escapeHTML(cat.nombre);
                btn.innerHTML = `<span class="text-2xl mb-2">${escapeHTML(cat.icono)}</span><span class="text-[9px] font-bold text-slate-300 uppercase tracking-wider text-center leading-tight">${escapeHTML(cat.nombre)}</span>`;
                wrapper.appendChild(btn);

                fragmentoCategorias.appendChild(wrapper);
            });

            const btnNuevaCat = document.createElement('button');
            btnNuevaCat.type = "button";
            btnNuevaCat.className = "btn-flujo-nueva flex flex-col items-center justify-center p-3 bg-slate-800/40 rounded-2xl active:bg-slate-700 border border-dashed border-emerald-500/40 shadow-sm min-h-[85px] cursor-pointer";
            btnNuevaCat.innerHTML = `<span class="text-2xl mb-1 text-emerald-400 font-light">+</span><span class="text-[9px] font-bold text-emerald-400 uppercase tracking-wider text-center">Nueva</span>`;
            fragmentoCategorias.appendChild(btnNuevaCat);
            
            contenedor.appendChild(fragmentoCategorias);

            // [NUEVO] Patrón Singleton Global: Un único listener en la memoria de Chrome
            if (!contenedor.dataset.listenerFlujoActivo) {
                contenedor.addEventListener('click', (e) => {
                    if (e.target.closest('.btn-flujo-nueva')) {
                        abrirModalNuevaCategoria();
                        return;
                    }
                    const btnCat = e.target.closest('.btn-flujo-cat');
                    if (btnCat && btnCat.dataset.catid) {
                        const nombreUpper = (btnCat.dataset.catnombre || '').toUpperCase();
                        if (nombreUpper.includes('OTROS') || nombreUpper.includes('EXTRA') || nombreUpper.includes('MEKATO')) {
                            abrirModal(btnCat.dataset.catid);
                        } else {
                            guardarTransaccion(btnCat.dataset.catid, '');
                        }
                    }
                });
                contenedor.dataset.listenerFlujoActivo = 'true';
            }
        }

       

        function abrirModalEditarPresupuesto(catId, catNombre, presupuestoActual) {
            categoriaEdicionId = catId;
            const lblC = document.getElementById('label-cat-editar-presupuesto'); if (lblC) lblC.textContent = `Categoría: ${catNombre}`;
            const inC = document.getElementById('input-nuevo-presupuesto-cat'); if (inC) inC.value = formateadorNumerico.format(parseInt(presupuestoActual || 0));
            
            const modal = document.getElementById('modal-editar-presupuesto');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            const inputPres = document.getElementById('input-nuevo-presupuesto-cat');
            setTimeout(() => {
                inputPres.focus();
                inputPres.select();
            }, 100);
        }

        function cerrarModalEditarPresupuesto() {
            document.getElementById('modal-editar-presupuesto')?.classList.add('hidden');
            document.getElementById('modal-editar-presupuesto')?.classList.remove('flex');
            categoriaEdicionId = null;
        }

        const btnCancelEditPres = document.getElementById('btn-cancelar-edit-presupuesto');
        if (btnCancelEditPres) btnCancelEditPres?.addEventListener('click', cerrarModalEditarPresupuesto);

        const inputEditPres = document.getElementById('input-nuevo-presupuesto-cat');
        if (inputEditPres) {
            inputEditPres?.addEventListener('input', (e) => {
                let valor = e.target.value.replace(/\D/g, '');
                if (!valor) { e.target.value = ''; return; }
                let numVal = parseInt(valor);
                if (numVal > 999999999) numVal = 999999999;
                e.target.value = formateadorNumerico.format(numVal);
            });
        }

        const btnGuardarEditPres = document.getElementById('btn-guardar-edit-presupuesto');
        if (btnGuardarEditPres) {
            btnGuardarEditPres?.addEventListener('click', async () => {
                if (!categoriaEdicionId) return;
                const rawVal = document.getElementById('input-nuevo-presupuesto-cat')?.value.replace(/\D/g, '');
                const nuevoMonto = parseInt(rawVal);
                if (isNaN(nuevoMonto) || nuevoMonto < 0) {
                    mostrarToast('Ingresa un monto válido', 'error');
                    return;
                }

                const { data: { session } } = await db.auth.getSession();
                if (!session) {
                    mostrarToast('Inicia sesión para guardar cambios', 'error');
                    return;
                }

                const { data: planExistente, error: errSelect } = await db.from('planes')
                    .select('id')
                    .eq('tipo', 'limite')
                    .eq('categoria_id', categoriaEdicionId)
                    .eq('user_id', session.user.id)
                    .maybeSingle();

                if (planExistente) {
                    const { error: errUpdate } = await db.from('planes').update({ monto: nuevoMonto }).eq('id', planExistente?.id);
                    if (errUpdate) {
                        mostrarToast('Error al actualizar presupuesto: ' + errUpdate.message, 'error');
                        return;
                    }
                } else {
                    let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                    const catObj = categorias.find(c => c.id === categoriaEdicionId);
                    const tituloPlan = catObj ? `Presupuesto ${catObj.nombre}` : 'Presupuesto Categoría';

                    const { error: insPlanError } = await db.from('planes').insert([{
                        tipo: 'limite',
                        monto: nuevoMonto,
                        titulo: tituloPlan,
                        categoria_id: categoriaEdicionId,
                        periodo: 'mensual',
                        auto_renovar: true,
                        user_id: session.user.id
                    }]);
                    if (insPlanError) {
                        mostrarToast('Error al crear límite: ' + insPlanError.message, 'error');
                        return;
                    }
                }

                cerrarModalEditarPresupuesto();
                mostrarToast('Presupuesto de categoría actualizado');
                cargarEstadisticas();
            });
        }

       async function aplicarAporteMeta(plan) {
            const valorAporte = parseInt(monto);
            
            if (isNaN(valorAporte) || valorAporte <= 0) {
                mostrarToast('Digita un monto mayor a cero en el teclado primero', 'error');
                cerrarFlujo();
                return;
            }
            
            try {
                const { data: { session }, error: errAuth } = await db.auth.getSession();
                if (errAuth || !session) throw new Error('Inicia sesión para gestionar metas');

                const nuevoAcumulado = parseFloat(plan.monto_acumulado || 0) + valorAporte;
                let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                const catAhorro = categorias.find(c => c.nombre.toLowerCase().includes('ahorro') || c.nombre.toLowerCase().includes('meta')) || categorias[0];

                // Generador pseudoaleatorio criptográfico para fallback y prevención de colisión de Primary Keys
                const generarIdSeguro = () => {
                    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
                    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                        const r = (window.crypto.getRandomValues(new Uint8Array(1))[0] % 16) | 0;
                        const v = c === 'x' ? r : (r & 0x3 | 0x8);
                        return v.toString(16);
                    });
                };

                const txPayload = {
                    id: generarIdSeguro(),
                    monto: valorAporte,
                    categoria_id: catAhorro ? catAhorro.id : null,
                    cuenta: cuentaActual,
                    fecha: new Date().toISOString(),
                    notas: `Aporte a meta: ${plan.titulo}`,
                    user_id: session.user.id
                };

                if (navigator.onLine) {
                    const { error: errPlan } = await db.from('planes').update({ monto_acumulado: nuevoAcumulado }).eq('id', plan?.id);
                    if (errPlan) throw new Error('Fallo al actualizar el acumulado: ' + errPlan.message);
                    
                    if (catAhorro) {
                        const { error: errTx } = await db.from('transacciones').insert([txPayload]);
                        if (errTx) throw new Error('Fallo al guardar la transacción contable: ' + errTx.message);
                    }
                } else {
                    let queueTx = JSON.parse(localStorage.getItem('offline_queue') || '[]');
                    queueTx.push(txPayload);
                    localStorage.setItem('offline_queue', JSON.stringify(queueTx));

                    let queuePlanes = JSON.parse(localStorage.getItem('offline_queue_planes') || '[]');
                    queuePlanes.push({ planId: plan?.id, nuevoAcumulado });
                    localStorage.setItem('offline_queue_planes', JSON.stringify(queuePlanes));
                    mostrarToast('Aporte encolado offline. Se sincronizará al conectar.');
                }

                mostrarToast(`🎯 Aporte de ${formatearMoneda(valorAporte)} sumado a "${plan.titulo}"`);
                cerrarFlujo();
                limpiar();
                cargarPlanes();
                cargarEstadisticas();
            } catch (err) {
                console.error('[CISO Audit] Cancelando aporte por falla crítica:', err.message);
                mostrarToast(err.message, 'error');
            }
        }

        async function aplicarAbonoDeuda(plan) {
            const valorAbono = parseInt(monto);
            
            if (isNaN(valorAbono) || valorAbono <= 0) {
                mostrarToast('Digita un monto mayor a cero en el teclado primero', 'error');
                cerrarFlujo();
                return;
            }
            
            try {
                const { data: { session }, error: errAuth } = await db.auth.getSession();
                if (errAuth || !session) throw new Error('Inicia sesión para gestionar deudas');

                const nuevoAcumulado = parseFloat(plan.monto_acumulado || 0) + valorAbono;
                let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                const catDeuda = categorias.find(c => c.nombre.toLowerCase().includes('deuda') || c.nombre.toLowerCase().includes('credito') || c.nombre.toLowerCase().includes('financiero')) || categorias[0];

                const txPayload = {
                    id: window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now().toString(),
                    monto: valorAbono,
                    categoria_id: catDeuda ? catDeuda.id : null,
                    cuenta: cuentaActual,
                    fecha: new Date().toISOString(),
                    notas: `Abono a deuda: ${plan.titulo}`,
                    user_id: session.user.id
                };

                if (navigator.onLine) {
                    const { error: errPlan } = await db.from('planes').update({ monto_acumulado: nuevoAcumulado }).eq('id', plan?.id);
                    if (errPlan) throw new Error('Fallo al actualizar el acumulado: ' + errPlan.message);
                    
                    if (catDeuda) {
                        const { error: errTx } = await db.from('transacciones').insert([txPayload]);
                        if (errTx) throw new Error('Fallo al guardar transacción: ' + errTx.message);
                    }
                } else {
                    let queueTx = JSON.parse(localStorage.getItem('offline_queue') || '[]');
                    queueTx.push(txPayload);
                    localStorage.setItem('offline_queue', JSON.stringify(queueTx));

                    let queuePlanes = JSON.parse(localStorage.getItem('offline_queue_planes') || '[]');
                    queuePlanes.push({ planId: plan?.id, nuevoAcumulado });
                    localStorage.setItem('offline_queue_planes', JSON.stringify(queuePlanes));
                    mostrarToast('Abono encolado offline. Se sincronizará al conectar.');
                }

                mostrarToast(`💳 Abono de ${formatearMoneda(valorAbono)} aplicado a "${plan.titulo}"`);
                cerrarFlujo(); 
                limpiar(); 
                cargarPlanes(); 
                cargarEstadisticas();
            } catch (err) {
                console.error('[CISO Audit] Cancelando abono por falla crítica:', err.message);
                mostrarToast(err.message, 'error');
            }
        }

        let categoriaEditandoId = null;
        let iconoEditarCatSeleccionado = '🍿';
        let tipoEditarCatEsFijo = false;

        function abrirModalEditarCategoria(cat) {
            categoriaEditandoId = cat?.id;
            const iec = document.getElementById('input-editar-cat-nombre'); if (iec) iec.value = cat.nombre;
            tipoEditarCatEsFijo = Boolean(cat.es_fijo);
            actualizarBotonesTipoEditarCat();

            const seccionTipo = document.getElementById('seccion-tipo-editar-cat');
            if (cat.tipo === 'ingreso') seccionTipo.classList.add('hidden');
            else seccionTipo.classList.remove('hidden');

            const inputEmojiCustom = document.getElementById('input-emoji-editar-personalizado');
            if (inputEmojiCustom) inputEmojiCustom.value = cat.icono || '🍿';
            iconoEditarCatSeleccionado = cat.icono || '🍿';

            const gridEmojis = document.getElementById('selector-iconos-editar-cat');
            if (gridEmojis) gridEmojis.textContent = '';

            inputEmojiCustom.oninput = (e) => {
                const val = e.target.value.trim();
                if (val) {
                    iconoEditarCatSeleccionado = val;
                    gridEmojis.querySelectorAll('button').forEach(btn => btn.className = 'p-2 rounded-xl text-xl flex items-center justify-center bg-slate-900 border border-slate-800');
                }
            };

            listaEmojisPopulares.forEach((emoji) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = `p-2 rounded-xl text-xl flex items-center justify-center transition-all ${emoji === iconoEditarCatSeleccionado ? 'bg-emerald-500/20 border border-emerald-500' : 'bg-slate-900 border border-slate-800'} cursor-pointer`;
                b.textContent = emoji;
                b?.addEventListener('click', () => {
                    gridEmojis.querySelectorAll('button').forEach(btn => btn.className = 'p-2 rounded-xl text-xl flex items-center justify-center bg-slate-900 border border-slate-800');
                    b.className = 'p-2 rounded-xl text-xl flex items-center justify-center bg-emerald-500/20 border border-emerald-500';
                    iconoEditarCatSeleccionado = emoji;
                    inputEmojiCustom.value = emoji;
                });
                gridEmojis.appendChild(b);
            });

            document.getElementById('modal-editar-cat')?.classList.remove('hidden');
            document.getElementById('modal-editar-cat')?.classList.add('flex');
            const inputEditarCatNombre = document.getElementById('input-editar-cat-nombre');
            if (inputEditarCatNombre) inputEditarCatNombre.focus();
        }

        function cerrarModalEditarCategoria() {
            document.getElementById('modal-editar-cat')?.classList.add('hidden');
            document.getElementById('modal-editar-cat')?.classList.remove('flex');
            categoriaEditandoId = null;
        }

        document.getElementById('btn-cancelar-editar-cat')?.addEventListener('click', cerrarModalEditarCategoria);

        document.getElementById('btn-editar-cat-var')?.addEventListener('click', () => {
            tipoEditarCatEsFijo = false;
            actualizarBotonesTipoEditarCat();
        });

        document.getElementById('btn-editar-cat-fijo')?.addEventListener('click', () => {
            tipoEditarCatEsFijo = true;
            actualizarBotonesTipoEditarCat();
        });

        function actualizarBotonesTipoEditarCat() {
            const btnVar = document.getElementById('btn-editar-cat-var');
            const btnFij = document.getElementById('btn-editar-cat-fijo');
            if (tipoEditarCatEsFijo) {
                btnFij.className = "py-2.5 rounded-xl text-xs font-bold border border-emerald-500/40 bg-emerald-500/20 text-emerald-300 cursor-pointer";
                btnVar.className = "py-2.5 rounded-xl text-xs font-bold border border-slate-700 bg-slate-800 text-slate-400 cursor-pointer";
            } else {
                btnVar.className = "py-2.5 rounded-xl text-xs font-bold border border-emerald-500/40 bg-emerald-500/20 text-emerald-300 cursor-pointer";
                btnFij.className = "py-2.5 rounded-xl text-xs font-bold border border-slate-700 bg-slate-800 text-slate-400 cursor-pointer";
            }
        }

        // [NUEVO] Handler de Edición Local - Exclusivo para Modo Borrador
        document.getElementById('btn-guardar-editar-cat')?.addEventListener('click', () => {
            if (!categoriaEditandoId) return;
            const nombre = document.getElementById('input-editar-cat-nombre')?.value.trim();
            const inputEmojiCustom = document.getElementById('input-emoji-editar-personalizado');
            const iconoFin = (inputEmojiCustom && inputEmojiCustom.value.trim()) ? inputEmojiCustom.value.trim() : iconoEditarCatSeleccionado;

            if (!nombre) {
                mostrarToast('Escribe un nombre válido', 'error');
                return;
            }

            // Solo consolida el estado local y marca con bandera '_editado'
            let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
            categorias = categorias.map(c => {
                if (c.id === categoriaEditandoId) {
                    return { ...c, nombre: escapeHTML(nombre), icono: escapeHTML(iconoFin), es_fijo: tipoEditarCatEsFijo, _editado: true };
                }
                return c;
            });
            
            localStorage.setItem('categorias_cache', JSON.stringify(categorias));
            
            cerrarModalEditarCategoria();
            abrirModalGestionarCategorias(); // Fuerza el re-render para mostrar la etiqueta "Pendiente" y el Botón Final
            mostrarToast('Edición en espera. Confirma para guardar en la nube.');
        });

        function abrirModalNuevaCategoria() {
            const inc = document.getElementById('input-nueva-cat-nombre'); if (inc) inc.value = '';
            tipoNuevaCatEsFijo = (tipoSubCatActual === 'fijo');
            actualizarBotonesTipoNuevaCat();
            
            const seccionTipo = document.getElementById('seccion-tipo-nueva-cat');
            if (tipoActual === 'ingreso') seccionTipo.classList.add('hidden');
            else seccionTipo.classList.remove('hidden');

            const inputEmojiCustom = document.getElementById('input-emoji-personalizado');
            if (inputEmojiCustom) inputEmojiCustom.value = listaEmojisPopulares[0];
            iconoNuevaCatSeleccionado = listaEmojisPopulares[0];

            inputEmojiCustom?.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                if (val) {
                    iconoNuevaCatSeleccionado = val;
                    gridEmojis.querySelectorAll('button').forEach(btn => btn.className = 'p-2 rounded-xl text-xl flex items-center justify-center bg-slate-900 border border-slate-800');
                }
            });

            const gridEmojis = document.getElementById('selector-iconos-cat');
            if (gridEmojis) {
                gridEmojis.textContent = '';
                
                // Patrón Singleton de delegación estática para prevenir leaks en el motor V8
                if (!gridEmojis.dataset.listenerActivo) {
                    gridEmojis.addEventListener('click', (e) => {
                        const btn = e.target.closest('button');
                        if (!btn) return;
                        
                        const emojiSeleccionado = btn.textContent;
                        gridEmojis.querySelectorAll('button').forEach(b => b.className = 'p-2 rounded-xl text-xl flex items-center justify-center transition-all bg-slate-900 border border-slate-800 cursor-pointer');
                        btn.className = 'p-2 rounded-xl text-xl flex items-center justify-center transition-all bg-emerald-500/20 border border-emerald-500 cursor-pointer';
                        
                        iconoNuevaCatSeleccionado = emojiSeleccionado;
                        const inputCustom = document.getElementById('input-emoji-personalizado');
                        if (inputCustom) inputCustom.value = emojiSeleccionado;
                    });
                    gridEmojis.dataset.listenerActivo = 'true';
                }

                listaEmojisPopulares.forEach((emoji, i) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = `p-2 rounded-xl text-xl flex items-center justify-center transition-all ${i === 0 ? 'bg-emerald-500/20 border border-emerald-500' : 'bg-slate-900 border border-slate-800'} cursor-pointer`;
                    b.textContent = emoji;
                    gridEmojis.appendChild(b);
                });
            }

            document.getElementById('modal-nueva-cat')?.classList.remove('hidden');
            document.getElementById('modal-nueva-cat')?.classList.add('flex');
            const inputNuevaCatNombre = document.getElementById('input-nueva-cat-nombre');
            if (inputNuevaCatNombre) inputNuevaCatNombre.focus();
        }

        function cerrarModalNuevaCategoria() {
            document.getElementById('modal-nueva-cat')?.classList.add('hidden');
            document.getElementById('modal-nueva-cat')?.classList.remove('flex');
        }

        document.getElementById('btn-cancelar-nueva-cat')?.addEventListener('click', cerrarModalNuevaCategoria);

        document.getElementById('btn-nueva-cat-var')?.addEventListener('click', () => {
            tipoNuevaCatEsFijo = false;
            actualizarBotonesTipoNuevaCat();
        });

        document.getElementById('btn-nueva-cat-fijo')?.addEventListener('click', () => {
            tipoNuevaCatEsFijo = true;
            actualizarBotonesTipoNuevaCat();
        });

        function actualizarBotonesTipoNuevaCat() {
            const btnVar = document.getElementById('btn-nueva-cat-var');
            const btnFij = document.getElementById('btn-nueva-cat-fijo');
            if (tipoNuevaCatEsFijo) {
                btnFij.className = "py-2.5 rounded-xl text-xs font-bold border border-emerald-500/40 bg-emerald-500/20 text-emerald-300 cursor-pointer";
                btnVar.className = "py-2.5 rounded-xl text-xs font-bold border border-slate-700 bg-slate-800 text-slate-400 cursor-pointer";
            } else {
                btnVar.className = "py-2.5 rounded-xl text-xs font-bold border border-emerald-500/40 bg-emerald-500/20 text-emerald-300 cursor-pointer";
                btnFij.className = "py-2.5 rounded-xl text-xs font-bold border border-slate-700 bg-slate-800 text-slate-400 cursor-pointer";
            }
        }

        const inputBuscarCat = document.getElementById('input-buscar-categoria');
        if (inputBuscarCat) {
            inputBuscarCat?.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase().trim();
                const botonesCat = document.querySelectorAll('#flujo-categorias-container > div, #flujo-categorias-container > button');
                botonesCat.forEach(el => {
                    const texto = el.textContent.toLowerCase();
                    if (texto.includes(query)) {
                        el.style.display = 'flex';
                    } else {
                        el.style.display = 'none';
                    }
                });
            });
        }

        document.getElementById('btn-guardar-nueva-cat')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-guardar-nueva-cat');
            if (btn.disabled) return;

            const inputNombreRaw = document.getElementById('input-nueva-cat-nombre')?.value.trim();
            const inputEmojiRaw = document.getElementById('input-emoji-personalizado') ? document.getElementById('input-emoji-personalizado')?.value.trim() : iconoNuevaCatSeleccionado;
            
            // [CISO FIX] Uso del proxy estandarizado 'escapeHTML' con fallback resiliente para modo offline
            const nombre = escapeHTML(inputNombreRaw);
            const iconoFinal = escapeHTML(inputEmojiRaw) || iconoNuevaCatSeleccionado;

            if (!nombre) {
                mostrarToast('Escribe un nombre seguro para la categoría', 'error');
                return;
            }

            try {
                btn.disabled = true;
                btn.innerHTML = '<span class="animate-pulse">Guardando...</span>';

                const { data: { session }, error: authError } = await db.auth.getSession();
                if (authError || !session) throw new Error('Sesión no válida. Inicia sesión.');

                const payloadCat = {
                    nombre: escapeHTML(nombre),
                    icono: escapeHTML(iconoFinal),
                    tipo: tipoActual,
                    es_fijo: tipoActual === 'gasto' ? tipoNuevaCatEsFijo : false,
                    user_id: session.user.id
                };

                const { data: newCatData, error: newCatError } = await db.from('categorias').insert([payloadCat]).select();
                if (newCatError) throw newCatError;

                let categoriasCache = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                if (newCatData && newCatData?.length > 0) {
                    categoriasCache = [...categoriasCache, newCatData[0]];
                    localStorage.setItem('categorias_cache', JSON.stringify(categoriasCache));
                }

                cerrarModalNuevaCategoria();
                renderizarCategoriasFlujo();
                mostrarToast(`Categoría "${nombre}" creada con éxito`);
            } catch (err) {
                console.error('[CISO Audit] Fallo al crear categoría:', err.message);
                mostrarToast('Error al crear categoría: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Guardar';
            }
        });

        let cacheTTL = { dashboard: 0, planes: 0 };

        function cambiarTab(pantalla) {
            const containerToast = document.getElementById('toast-container');
            if (containerToast) containerToast.textContent = '';

            const pantallas = ['captura', 'planes', 'dashboard', 'ajustes'];
            
            // Renderizado crítico inferior a 16ms (< 60fps) agrupando manipulación del DOM
            requestAnimationFrame(() => {
                pantallas.forEach(p => {
                    const el = document.getElementById(`pantalla-${p}`);
                    const tab = document.getElementById(`tab-${p}`);
                    const esActiva = p === pantalla;
                    
                    if (esActiva) {
                        el.classList.remove('hidden'); 
                        el.classList.add('flex');
                        tab.classList.replace('tab-inactiva', 'tab-activa');
                    } else {
                        if (!el.classList.contains('hidden')) {
                            el.classList.add('hidden'); 
                            el.classList.remove('flex');
                            tab.classList.replace('tab-activa', 'tab-inactiva');
                        }
                    }
                });
                
                // [Seguridad Multiplataforma] Polyfill para WebKit/Safari (iOS/macOS)
                const safeIdleCallback = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
                
                // Renderizado Diferido No Bloqueante (Async Pipeline)
                requestAnimationFrame(() => {
                    const ahora = Date.now();
                    
                    if (pantalla === 'dashboard') {
                        if (ahora - cacheTTL.dashboard > 60000 || transaccionesCacheActuales.length === 0) {
                            // Ejecutamos cargas pesadas fuera del pipeline de pintado
                            safeIdleCallback(() => {
                                cargarEstadisticas().finally(() => cacheTTL.dashboard = Date.now());
                            }, { timeout: 1000 });
                        } else if (graficoInstancia) {
                            requestAnimationFrame(() => graficoInstancia.update());
                        }
                    }
                    
                    if (pantalla === 'planes') {
                        if (ahora - cacheTTL.planes > 60000) {
                            safeIdleCallback(() => {
                                cargarPlanes().finally(() => cacheTTL.planes = Date.now());
                            }, { timeout: 1000 });
                        }
                    }
                }); 
            });
        }

        // [CISO] Eliminada la duplicación top-level para erradicar llamadas dobles y fugas de memoria
        
        document.addEventListener('DOMContentLoaded', () => {
    try {
        if (typeof db === 'undefined' || !db) {
            console.warn("Supabase (db) aún no inicializado durante asignación de eventos globales.");
        }

        document.getElementById('tab-captura')?.addEventListener('click', () => cambiarTab('captura'));
        document.getElementById('tab-planes')?.addEventListener('click', () => cambiarTab('planes'));
        document.getElementById('tab-dashboard')?.addEventListener('click', () => cambiarTab('dashboard'));
        document.getElementById('tab-ajustes')?.addEventListener('click', () => cambiarTab('ajustes'));
        
        document.getElementById('filtro-tiempo')?.addEventListener('change', async (e) => {
            try {
                if (typeof db === 'undefined' || !db) {
                    throw new Error("Cliente Supabase no disponible para cargar estadísticas.");
                }
                const selectorMes = document.getElementById('selector-mes-excel');
                if (selectorMes) {
                    if (e.target.value === 'mes') {
                        selectorMes.classList.remove('hidden');
                    } else {
                        selectorMes.classList.add('hidden');
                    }
                }
                await cargarEstadisticas();
            } catch (error) {
                console.error("Error en evento filtro-tiempo:", error);
            }
        });
        document.getElementById('btn-cancelar-notas')?.addEventListener('click', cerrarModal);
        
        document.getElementById('btn-guardar-notas')?.addEventListener('click', async () => {
            try {
                if (typeof db === 'undefined' || !db) {
                    throw new Error("Cliente Supabase no disponible al guardar transacción.");
                }
                await guardarTransaccion(categoriaPendiente, document.getElementById('input-notas')?.value.trim());
                cerrarModal();
            } catch (error) {
                console.error("Error en evento btn-guardar-notas:", error);
            }
        });
        document.getElementById('btn-fab-plan')?.addEventListener('click', abrirModalPlanes);
        document.getElementById('btn-cancelar-planes')?.addEventListener('click', cerrarModalPlanes);
        
        document.getElementById('btn-crear-limite')?.addEventListener('click', () => abrirFormularioPlan('limite'));
        document.getElementById('btn-crear-meta')?.addEventListener('click', () => abrirFormularioPlan('meta'));
        document.getElementById('btn-crear-deuda')?.addEventListener('click', () => abrirFormularioPlan('deuda'));
    } catch (err) {
        console.error("Error crítico de inicialización de UI:", err);
    }
});

function abrirModal(catId) {
    categoriaPendiente = catId;
    const modal = document.getElementById('modal-notas');
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
    const inputNotas = document.getElementById('input-notas');
    if (inputNotas) {
        inputNotas.focus();
    }
}

function cerrarModal() {
    const modalNotas = document.getElementById('modal-notas');
    if (modalNotas) {
        modalNotas.classList.add('hidden');
        modalNotas.classList.remove('flex');
    }
    const inputNotas = document.getElementById('input-notas');
    if (inputNotas) {
        inputNotas.value = '';
    }
    categoriaPendiente = null;
}

function abrirModalPlanes() {
    const modalTipoPlan = document.getElementById('modal-tipo-plan');
    if (modalTipoPlan) {
        modalTipoPlan.classList.remove('hidden');
        modalTipoPlan.classList.add('flex');
    }
}

function cerrarModalPlanes() {
    const modalTipoPlan = document.getElementById('modal-tipo-plan');
    if (modalTipoPlan) {
        modalTipoPlan.classList.add('hidden');
        modalTipoPlan.classList.remove('flex');
    }
}


        document.getElementById('btn-fab-plan')?.addEventListener('click', abrirModalPlanes);
        document.getElementById('btn-cancelar-planes')?.addEventListener('click', cerrarModalPlanes);

        document.getElementById('btn-crear-limite')?.addEventListener('click', () => abrirFormularioPlan('limite'));
        document.getElementById('btn-crear-meta')?.addEventListener('click', () => abrirFormularioPlan('meta'));
        document.getElementById('btn-crear-deuda')?.addEventListener('click', () => abrirFormularioPlan('deuda'));

        async function abrirFormularioPlan(tipo) {
            cerrarModalPlanes();
            tipoPlanActivo = tipo;
            const titulos = { limite: 'Controlar Límite / Fijo', meta: 'Nueva Meta de Ahorro', deuda: 'Registrar Deuda / Crédito' };
            const tfp = document.getElementById('titulo-form-plan'); if (tfp) tfp.textContent = titulos[tipo] || 'Nuevo Plan';
            const imp = document.getElementById('input-monto-plan'); if (imp) imp.value = '';
            const inp = document.getElementById('input-nombre-plan'); if (inp) inp.value = '';
            const iap = document.getElementById('input-acumulado-inicial'); if (iap) iap.value = '';

            const campoCat = document.getElementById('campo-categoria-plan');
            const campoPeriodo = document.getElementById('campo-periodo-plan');
            const campoFechas = document.getElementById('campo-fechas-plan');
            const campoAuto = document.getElementById('campo-auto-renovar');
            const campoEmergencia = document.getElementById('campo-fondo-emergencia');
            const campoInicio = document.getElementById('campo-mostrar-inicio');
            const campoAcumulado = document.getElementById('campo-monto-acumulado-inicial');

            if(campoCat) campoCat.classList.add('hidden');
            if(campoPeriodo) campoPeriodo.classList.add('hidden');
            if(campoFechas) campoFechas.classList.add('hidden');
            if(campoAuto) campoAuto.classList.add('hidden');
            if(campoEmergencia) campoEmergencia.classList.add('hidden');
            if(campoInicio) campoInicio.classList.add('hidden');
            if(campoAcumulado) campoAcumulado.classList.add('hidden');

            if (tipo === 'limite') {
                if(campoCat) campoCat.classList.remove('hidden');
                if(campoPeriodo) campoPeriodo.classList.remove('hidden');
                if(campoAuto) campoAuto.classList.remove('hidden');

                let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                let idsEliminadas = JSON.parse(localStorage.getItem('categorias_eliminadas_ids') || '[]');
                categorias = categorias.filter(c => !idsEliminadas.includes(c.id));

                if (categorias.length === 0) {
                    const { data, error: errCat } = await db.from('categorias').select('*').order('nombre');
                    if (data) categorias = data.filter(c => !idsEliminadas.includes(c.id));
                }
                const selectCat = document.getElementById('select-categoria-plan');
                selectCat.innerHTML = '<option value="">-- Elige la categoría --</option>';
                categorias.filter(c => c.tipo === 'gasto').forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.id;
                    opt.textContent = `${c.icono} ${c.nombre}`;
                    selectCat.appendChild(opt);
                });

            } else if (tipo === 'meta') {
    campoEmergencia.classList.remove('hidden');
    campoInicio.classList.remove('hidden');
    campoAcumulado.classList.remove('hidden');
    const targetText1 = document.getElementById('label-acumulado-inicial');
    if (targetText1) {
        targetText1.textContent = 'Ya Ahorrado Inicialmente (Opcional)';
    }
} else if (tipo === 'deuda') {
    campoInicio.classList.remove('hidden');
    campoAcumulado.classList.remove('hidden');
    const targetText2 = document.getElementById('label-acumulado-inicial');
    if (targetText2) {
        targetText2.textContent = 'Ya Pagado / Amortizado (Opcional)';
    }
}


            const modalFormPlan = document.getElementById('modal-form-plan');
            if (modalFormPlan) {
                modalFormPlan.classList.remove('hidden');
                modalFormPlan.classList.add('flex');
            }
            const inputMontoPlan = document.getElementById('input-monto-plan');
            if (inputMontoPlan) inputMontoPlan.focus();
        }

        document.getElementById('select-periodo-plan')?.addEventListener('change', (e) => {
            const campoFechas = document.getElementById('campo-fechas-plan');
            if (e.target.value === 'personalizado') campoFechas.classList.remove('hidden');
            else campoFechas.classList.add('hidden');
        });

        function cerrarFormularioPlan() {
            document.getElementById('modal-form-plan')?.classList.add('hidden');
            document.getElementById('modal-form-plan')?.classList.remove('flex');
        }

        document.getElementById('btn-cancelar-form-plan')?.addEventListener('click', cerrarFormularioPlan);
        
        document.getElementById('input-monto-plan')?.addEventListener('input', (e) => {
            let valor = e.target.value.replace(/\D/g, '');
            if (!valor) { e.target.value = ''; return; }
            e.target.value = formateadorNumerico.format(parseInt(valor));
        });

        document.getElementById('input-acumulado-inicial')?.addEventListener('input', (e) => {
            let valor = e.target.value.replace(/\D/g, '');
            if (!valor) { e.target.value = ''; return; }
            e.target.value = formateadorNumerico.format(parseInt(valor));
        });

        document.getElementById('btn-guardar-plan')?.addEventListener('click', async () => {
            const btnGuardar = document.getElementById('btn-guardar-plan');
            if (btnGuardar.disabled) return;

            const rawMonto = document.getElementById('input-monto-plan')?.value.replace(/\D/g, '');
            const montoVal = parseInt(rawMonto);
            const tituloVal = document.getElementById('input-nombre-plan')?.value.trim();
            const rawAcum = document.getElementById('input-acumulado-inicial')?.value.replace(/\D/g, '');
            const acumVal = rawAcum ? parseInt(rawAcum) : 0;
            
            if(!montoVal || montoVal <= 0 || !tituloVal) {
                mostrarToast('Ingresa un monto y un nombre válidos', 'error');
                return;
            }

            const { data: { session } } = await db.auth.getSession();
            if (!session) {
                mostrarToast('Debes iniciar sesión para guardar planes', 'error');
                return;
            }

            btnGuardar.disabled = true;
            btnGuardar.classList.add('opacity-50');

            const payload = { 
                tipo: tipoPlanActivo, 
                monto: montoVal, 
                titulo: escapeHTML(tituloVal),
                user_id: session.user.id,
                monto_acumulado: acumVal
            };

            if (tipoPlanActivo === 'limite') {
                const catId = document.getElementById('select-categoria-plan')?.value;
                if (!catId) {
                    mostrarToast('Selecciona la categoría a controlar', 'error');
                    btnGuardar.disabled = false;
                    btnGuardar.classList.remove('opacity-50');
                    return;
                }
                payload.categoria_id = catId;
                payload.periodo = document.getElementById('select-periodo-plan')?.value;
                payload.auto_renovar = document.getElementById('check-auto-renovar').checked;
                
                if (payload.periodo === 'personalizado') {
                    payload.fecha_inicio = document.getElementById('input-fecha-inicio-plan')?.value || new Date().toISOString().slice(0,10);
                    payload.fecha_fin = document.getElementById('input-fecha-fin-plan')?.value || null;
                }
            } else if (tipoPlanActivo === 'meta') {
                payload.es_fondo_emergencia = document.getElementById('check-fondo-emergencia').checked;
                payload.mostrar_en_inicio = document.getElementById('check-mostrar-inicio').checked;
            } else if (tipoPlanActivo === 'deuda') {
                payload.mostrar_en_inicio = document.getElementById('check-mostrar-inicio').checked;
            }

            const { error: insPError } = await db.from('planes').insert([payload]);
            btnGuardar.disabled = false;
            btnGuardar.classList.remove('opacity-50');
            
            if(!insPError) {
                cerrarFormularioPlan();
                cargarPlanes();
                mostrarToast('Plan guardado con éxito');
            } else {
                mostrarToast('Error al guardar plan: ' + insPError.message, 'error');
            }
        });

        function calcularVentanaPeriodo(periodo, fechaInicioGuardada, fechaFinGuardada, autoRenovar) {
            const ahora = new Date();
            let inicio, fin;

            const anio = ahora.getFullYear();
            const mes = ahora.getMonth();
            const dia = ahora.getDate();

            if (periodo === 'semanal') {
                const diaSemana = (ahora.getDay() + 6) % 7;
                inicio = new Date(anio, mes, dia - diaSemana, 0, 0, 0, 0);
                fin = new Date(anio, mes, dia - diaSemana + 6, 23, 59, 59, 999);
            } else if (periodo === 'quincenal') {
                if (dia <= 15) {
                    inicio = new Date(anio, mes, 1, 0, 0, 0, 0);
                    fin = new Date(anio, mes, 15, 23, 59, 59, 999);
                } else {
                    inicio = new Date(anio, mes, 16, 0, 0, 0, 0);
                    fin = new Date(anio, mes + 1, 0, 23, 59, 59, 999);
                }
            } else if (periodo === 'trimestral') {
                const q = Math.floor(mes / 3);
                inicio = new Date(anio, q * 3, 1, 0, 0, 0, 0);
                fin = new Date(anio, q * 3 + 3, 0, 23, 59, 59, 999);
            } else if (periodo === 'semestral') {
                const sem = mes < 6 ? 0 : 6;
                inicio = new Date(anio, sem, 1, 0, 0, 0, 0);
                fin = new Date(anio, sem + 6, 0, 23, 59, 59, 999);
            } else if (periodo === 'anual') {
                inicio = new Date(anio, 0, 1, 0, 0, 0, 0);
                fin = new Date(anio, 11, 31, 23, 59, 59, 999);
            } else if (periodo === 'personalizado' && fechaInicioGuardada && fechaFinGuardada) {
                inicio = new Date(fechaInicioGuardada);
                fin = new Date(fechaFinGuardada);
                if (autoRenovar && ahora > fin) {
                    const duracionMs = fin.getTime() - inicio.getTime();
                    while (ahora > fin) {
                        inicio = new Date(inicio.getTime() + duracionMs);
                        fin = new Date(fin.getTime() + duracionMs);
                    }
                }
            } else {
                inicio = new Date(anio, mes, 1, 0, 0, 0, 0);
                fin = new Date(anio, mes + 1, 0, 23, 59, 59, 999);
            }
            return { inicio: inicio.toISOString(), fin: fin.toISOString() };
        }

        async function verificarAlertaLimite(categoriaId, nuevoGasto) {
            const { data: { session } } = await db.auth.getSession();
            if (!session) return;

            // Optimización V8: Lectura directa desde caché inmutable O(1) eliminando latencia de red
            const planesGuardados = leerStorageSeguro('planes_cache', []);
            const limites = planesGuardados.filter(p => p.tipo === 'limite' && p.categoria_id === categoriaId && p.user_id === session.user.id);

            if (!limites || limites.length === 0) return;

            for (let lim of limites) {
                const rango = calcularVentanaPeriodo(lim.periodo || 'mensual', lim.fecha_inicio, lim.fecha_fin, lim.auto_renovar);
                
                // Cálculo determinista en memoria sobre la matriz principal
                const gastadoAnterior = transaccionesCacheActuales
                    .filter(t => t.categoria_id === categoriaId && t.fecha >= rango.inicio && t.fecha <= rango.fin)
                    .reduce((acc, t) => acc + parseFloat(t.monto), 0);
                const gastadoTotal = gastadoAnterior + nuevoGasto;
                const tope = parseFloat(lim.monto);
                const porcentaje = tope > 0 ? Math.round((gastadoTotal / tope) * 100) : 0;

                if (gastadoTotal >= tope) {
                    mostrarToast(`🚨 Sobregiro en "${lim.titulo}" (${formatearMoneda(gastadoTotal)} de ${formatearMoneda(tope)})`, 'error');
                } else if (porcentaje >= 80) {
                    mostrarToast(`⚠️ Consumiste el ${porcentaje}% del límite en "${lim.titulo}"`, 'error');
                }
            }
        }

        let guardandoTransaccionActiva = false;

       async function guardarTransaccion(categoriaId, notaGasto) {
            if (guardandoTransaccionActiva) return;
            const valorGasto = parseInt(monto, 10);
            if (isNaN(valorGasto) || valorGasto <= 0) {
                mostrarToast('El monto debe ser mayor a cero.', 'error');
                cerrarFlujo();
                limpiar();
                return;
            }

            let payload = null;
            try {
                if (!db || typeof db.auth === 'undefined') throw new Error('Conexión con la base de datos interrumpida. Guardando offline.');
                const { data: { session }, error: authError } = await db.auth.getSession();
                if (authError || !session) {
                    mostrarToast('Debes iniciar sesión para registrar movimientos', 'error');
                    return;
                }

                guardandoTransaccionActiva = true;

                let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
                const catObj = categorias.find(c => c.id === categoriaId);

                if (catObj && catObj.tipo === 'ingreso') {
                    await generarRecomendacionSueldo(valorGasto).catch(e => console.warn('Aviso sueldo:', e));
                }

                if (catObj && catObj.tipo === 'gasto') {
                    await verificarAlertaLimite(categoriaId, valorGasto).catch(e => console.warn('Aviso límite:', e));
                }

                payload = {
                    id: window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                        const r = (window.crypto.getRandomValues(new Uint8Array(1))[0] % 16) | 0;
                        const v = c === 'x' ? r : (r & 0x3 | 0x8);
                        return v.toString(16);
                    }),
                    monto: valorGasto,
                    categoria_id: categoriaId,
                    cuenta: escapeHTML(cuentaActual),
                    fecha: new Date().toISOString(),
                    notas: notaGasto ? escapeHTML(notaGasto.trim().slice(0, 150)) : null,
                    user_id: session.user.id
                };

                const display = document.getElementById('flujo-monto-display');

                if (navigator.onLine) {
                    const { error: insTxError } = await db.from('transacciones').insert([payload]);
                    if (insTxError) throw insTxError; 
                } else {
                    encolarTransaccionManual(payload);
                }

                if (catObj && catObj.tipo === 'gasto') {
                    const porcentajeGastoDash = ultimosIngresosCalculados > 0 ? Math.round((valorGasto / ultimosIngresosCalculados) * 100) : 0;
                    if (porcentajeGastoDash >= 20) {
                        setTimeout(() => {
                            mostrarToast(`⚠️ Este gasto representa el ${porcentajeGastoDash}% de tus ingresos totales. ¡Vigila tu margen!`, 'error');
                        }, 500);
                    }
                }

                if (navigator.vibrate) navigator.vibrate(50);

                if (display) display.style.color = '#34d399';
                setTimeout(() => {
                    if (display) display.style.color = 'white';
                    cerrarFlujo();
                    limpiar();
                    guardandoTransaccionActiva = false;
                    mostrarToast('Transacción registrada con éxito');
                    if (document.getElementById('pantalla-dashboard') && !document.getElementById('pantalla-dashboard')?.classList.contains('hidden')) {
                        cargarEstadisticas();
                    }
                }, 300);

            } catch (errorGlobal) {
                console.warn('Excepción atrapada en red/guardado:', errorGlobal);
                guardandoTransaccionActiva = false;
                const display = document.getElementById('flujo-monto-display');
                
                const isNetworkError = errorGlobal.message === 'Failed to fetch' || String(errorGlobal).includes('Network');
                if (isNetworkError && payload) {
                    encolarTransaccionManual(payload);
                    if (display) display.style.color = '#34d399';
                    setTimeout(() => {
                        if (display) display.style.color = 'white';
                        cerrarFlujo(); limpiar();
                        if (document.getElementById('pantalla-dashboard') && !document.getElementById('pantalla-dashboard')?.classList.contains('hidden')) cargarEstadisticas();
                    }, 300);
                    return;
                }

                if (display) {
                    display.style.color = '#ef4444';
                    setTimeout(() => display.style.color = 'white', 1000);
                }
                mostrarToast('Hubo un problema de conexión o sesión. Revisa tu red.', 'error');
            }
        }

function encolarTransaccionManual(payload) {
  let queue = JSON.parse(localStorage.getItem('offline_queue') || '[]');
  queue.push(payload);
  try {
    localStorage.setItem('offline_queue', JSON.stringify(queue));
    mostrarToast('Guardado offline. Se sincronizará al conectar.');
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      const itemsAQuitar = Math.max(1, Math.floor(queue.length * 0.2));
      queue.splice(0, itemsAQuitar);
      localStorage.setItem('offline_queue', JSON.stringify(queue));
      mostrarToast('Almacenamiento casi lleno. Conéctate a internet para vaciar la cola.', 'error');
    }
  }
}

        async function cargarPlanes() {
            let session = null;
            try {
                const { data, error } = await db.auth.getSession();
                if (error) throw error;
                session = data?.session;
            } catch (err) {
                console.warn('[CISO Guard] Error recuperando sesión en Planes:', err.message);
            }

            const contenedor = document.getElementById('contenedor-planes');
            const fab = document.getElementById('btn-fab-plan');

            if (!session) {
                if (contenedor) contenedor.textContent = '';
                if (fab) fab.classList.add('hidden');
                return;
            }

            // [OPTIMIZACIÓN ZERO-LATENCY]: Caché-First Render
            let transacciones = transaccionesCacheActuales || [];
            let planesGuardados = leerStorageSeguro('planes_cache', []);

            const procesarYRenderizar = (listaPlanes, listaTrans) => {
                if(!listaPlanes || listaPlanes.length === 0) {
                    fab.classList.add('hidden');
                    contenedor.textContent = `
                    <div class="flex flex-col items-center justify-center h-full text-center mt-12">
                        <div class="w-20 h-20 bg-slate-900 rounded-full flex items-center justify-center border border-slate-800 mb-6 shadow-lg">
                            <span class="text-3xl text-emerald-500 font-light">+</span>
                        </div>
                        <h3 class="text-lg font-bold text-white mb-2">No tienes ningún plan o meta</h3>
                        <p class="text-sm text-slate-500 mb-8 max-w-xs">Organiza tus límites por categoría, metas con fondo de emergencia y deudas</p>
                        <button id="btn-primer-plan" class="text-emerald-400 font-bold text-sm tracking-widest uppercase cursor-pointer">CREAR MI PRIMER PLAN</button>
                    </div>`;
                    const btnPrimerPlan = document.getElementById('btn-primer-plan');
                    if(btnPrimerPlan) btnPrimerPlan?.addEventListener('click', abrirModalPlanes);
                    return;
                } 
                
                fab.classList.remove('hidden');
                contenedor.textContent = '';
                
                const fragmentoPlanes = document.createDocumentFragment();

                listaPlanes.forEach(p => {
                    const tipo = p.tipo;
                    let estiloBadge = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
                    let iconoTipo = '🎯';
                    let etiquetaTipo = 'Meta de Ahorro';
                    let barraColor = 'bg-emerald-500';
                    let porcentaje = 0;
                    let textoMetricaPrincipal = '';
                    let textoMetricaSecundaria = '';

                    if (tipo === 'limite') {
                        estiloBadge = 'bg-red-500/10 text-red-400 border-red-500/20';
                        iconoTipo = '🛡️';
                        etiquetaTipo = `Límite (${(p.periodo || 'mensual').toUpperCase()})`;
                        
                        const rango = calcularVentanaPeriodo(p.periodo || 'mensual', p.fecha_inicio, p.fecha_fin, p.auto_renovar);
                        const gastadoPeriodo = (listaTrans || [])
                            .filter(t => t.categoria_id === p.categoria_id && t.fecha >= rango.inicio && t.fecha <= rango.fin)
                            .reduce((acc, t) => acc + parseFloat(t.monto), 0);

                        const tope = parseFloat(p.monto);
                        porcentaje = tope > 0 ? Math.round((gastadoPeriodo / tope) * 100) : 0;
                        textoMetricaPrincipal = `${formatearMoneda(gastadoPeriodo)} / ${formatearMoneda(tope)}`;
                        textoMetricaSecundaria = `${porcentaje}% consumido`;

                        if (porcentaje >= 100) {
                            barraColor = 'bg-red-500';
                            estiloBadge = 'bg-red-500/10 text-red-400 border-red-500/20';
                            textoMetricaSecundaria += ' • ¡SOBREGIRO!';
                        } else if (porcentaje >= 80) {
                            barraColor = 'bg-amber-500';
                            estiloBadge = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
                            textoMetricaSecundaria += ' • ALERTA';
                        } else {
                            barraColor = 'bg-emerald-500';
                            estiloBadge = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
                        }
                    } else if (tipo === 'meta') {
                        estiloBadge = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
                        iconoTipo = p.es_fondo_emergencia ? '🚨' : '🎯';
                        etiquetaTipo = p.es_fondo_emergencia ? 'Fondo de Emergencia' : 'Meta de Ahorro';
                        const acum = parseFloat(p.monto_acumulado || 0);
                        const obj = parseFloat(p.monto);
                        porcentaje = obj > 0 ? Math.min(100, Math.round((acum / obj) * 100)) : 0;
                        textoMetricaPrincipal = `${formatearMoneda(acum)} / ${formatearMoneda(obj)}`;
                        textoMetricaSecundaria = `${porcentaje}% acumulado`;
                        barraColor = 'bg-emerald-500';
                    } else if (tipo === 'deuda') {
                        estiloBadge = 'bg-blue-500/10 text-blue-400 border-blue-500/20';
                        iconoTipo = '💳';
                        etiquetaTipo = 'Crédito / Deuda';
                        const totalDeuda = parseFloat(p.monto);
                        const pagado = parseFloat(p.monto_acumulado || 0);
                        const restante = Math.max(0, totalDeuda - pagado);
                        porcentaje = totalDeuda > 0 ? Math.min(100, Math.round((pagado / totalDeuda) * 100)) : 0;
                        textoMetricaPrincipal = `Saldo restante: ${formatearMoneda(restante)}`;
                        textoMetricaSecundaria = `${porcentaje}% pagado (${formatearMoneda(pagado)} de ${formatearMoneda(totalDeuda)})`;
                        barraColor = 'bg-blue-500';
                    }

                    const wrapper = document.createElement('div');
                    wrapper.className = "relative overflow-hidden rounded-3xl mb-4 bg-red-500 flex justify-end";
                    
                    const btnDelete = document.createElement('button');
                    btnDelete.type = "button";
                    btnDelete.className = "absolute right-0 top-0 bottom-0 w-24 flex flex-col items-center justify-center text-white font-bold active:bg-red-600 transition-colors cursor-pointer";
                    btnDelete.innerHTML = `<span class="text-xl mb-1">🗑️</span><span class="text-[10px] uppercase tracking-wider">Borrar</span>`;
                    btnDelete?.addEventListener('click', () => eliminarPlan(p?.id));
                    wrapper.appendChild(btnDelete);

                    const tarjeta = document.createElement('div');
                    tarjeta.className = "bg-slate-900 p-5 rounded-3xl border border-slate-800 shadow-md relative z-10 w-full transition-transform duration-200 touch-pan-y";
                    tarjeta.textContent = `
                        <div class="flex items-center justify-between mb-3">
                            <div class="flex items-center gap-3">
                                <div class="w-10 h-10 rounded-full flex items-center justify-center border ${estiloBadge} text-lg">${iconoTipo}</div>
                                <div>
                                    <p class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">${etiquetaTipo}</p>
                                    <p class="text-sm font-bold text-white">${escapeHTML(p.titulo)}</p>
                                </div>
                            </div>
                            ${p.mostrar_en_inicio ? '<span class="text-[9px] bg-slate-800 border border-slate-700 text-slate-400 font-bold px-2 py-0.5 rounded-full">⚡ En Inicio</span>' : ''}
                        </div>

                        <div class="flex justify-between items-baseline mb-2">
                            <h4 class="text-lg font-extrabold text-white">${textoMetricaPrincipal}</h4>
                            <span class="text-[10px] font-bold text-slate-400">${textoMetricaSecundaria}</span>
                        </div>

                        <div class="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                            <div class="${barraColor} h-2 rounded-full transition-all duration-500" style="width: ${Math.min(100, porcentaje)}%"></div>
                        </div>
                    `;
                    
                    let startX = 0, currentX = 0, isDragging = false;
                    tarjeta?.addEventListener('touchstart', e => { 
                        startX = e.touches[0].clientX; 
                        currentX = startX;
                        isDragging = true; 
                        tarjeta.style.transition = 'none';
                    }, {passive: true});
                    
                    tarjeta?.addEventListener('touchmove', e => {
                        if(!isDragging) return;
                        currentX = e.touches[0].clientX;
                        let diff = currentX - startX;
                        if(diff < 0) tarjeta.style.transform = `translateX(${Math.max(diff, -100)}px)`;
                    }, {passive: true});
                    
                    tarjeta?.addEventListener('touchend', () => {
                        isDragging = false;
                        tarjeta.style.transition = 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)';
                        let diff = currentX - startX;
                        if(diff < -50) tarjeta.style.transform = 'translateX(-96px)'; 
                        else tarjeta.style.transform = 'translateX(0)'; 
                        startX = 0; currentX = 0;
                    });

                    wrapper.appendChild(tarjeta);
                    fragmentoPlanes.appendChild(wrapper);
                });
                
                contenedor.appendChild(fragmentoPlanes);
            };

            // 1. Mostrar de inmediato la caché
            if (planesGuardados.length > 0) procesarYRenderizar(planesGuardados, transacciones);

            // 2. Traer fresco de BD sin bloquear UI
            if (navigator.onLine) {
                db.from('planes')
                    .select('*')
                    .eq('user_id', session.user.id)
                    .order('creado_en', { ascending: false })
                    .then(({ data: planesNuevos, error }) => {
                        if (!error && planesNuevos) {
                            const strViejo = JSON.stringify(planesGuardados);
                            const strNuevo = JSON.stringify(planesNuevos);
                            if (strViejo !== strNuevo || planesGuardados.length === 0) {
                                localStorage.setItem('planes_cache', strNuevo);
                                procesarYRenderizar(planesNuevos, transacciones);
                            }
                        }
                    })
                    .catch(err => console.warn('Silencio en fetch planes:', err));
            }
        }

        async function eliminarPlan(id) {
            try {
                if (!navigator.onLine) throw new Error("Requiere conexión a internet activa.");
                
                const { error: delPlanError } = await db.from('planes').delete().eq('id', id);
                if (delPlanError) throw delPlanError;
                
                mostrarToast('Plan eliminado');
                cargarPlanes();
            } catch (err) {
                console.error('[Supabase Excepción] Error al eliminar plan:', err.message);
                mostrarToast('No se pudo borrar el plan: ' + err.message, 'error');
            }
        }

        async function generarRecomendacionSueldo(sueldoIngresado) {
            try {
                const { data: { session } } = await db.auth.getSession();
                if (!session) return;
                
                const { data: planes, error: errPlanes } = await db.from('planes').select('*').eq('user_id', session.user.id);
                if (errPlanes) throw errPlanes;
                
                let totalFijosYDeudas = 0;
                let tieneFondoEmergencia = false;
                
                if (planes) {
                    planes.forEach(p => {
                        if (p.tipo === 'limite') {
                            totalFijosYDeudas += parseFloat(p.monto);
                        } else if (p.tipo === 'deuda') {
                            const pendiente = Math.max(0, parseFloat(p.monto) - parseFloat(p.monto_acumulado || 0));
                            totalFijosYDeudas += Math.min(pendiente, parseFloat(p.monto) * 0.10);
                        }
                        if (p.tipo === 'meta' && p.es_fondo_emergencia) {
                            tieneFondoEmergencia = true;
                        }
                    });
                }

                const margenLimpio = sueldoIngresado - totalFijosYDeudas;
                
                if (margenLimpio <= 0) {
                    mostrarToast("⚠️ Tus compromisos fijos y deudas igualan o superan tu salario registrado.", "error");
                    return;
                }

                if (tieneFondoEmergencia) {
                    const sugeridoFondo = Math.round(margenLimpio * 0.20);
                    mostrarToast(`🚨 De tu sueldo de ${formatearMoneda(sueldoIngresado)}, fijos y deudas suman ${formatearMoneda(totalFijosYDeudas)}. Aparta ${formatearMoneda(sugeridoFondo)} (20% del restante) para tu fondo de emergencia.`);
                } else {
                    mostrarToast(`💰 Sueldo recibido. Margen limpio disponible: ${formatearMoneda(margenLimpio)} tras compromisos.`);
                }
            } catch (error) {
                console.warn('[CISO Guard] Fuga de asincronía neutralizada en cálculo de sueldo:', error.message);
            }
        }

        function limpiar() { 
            monto = '0'; 
            actualizarPantalla(); 
        }

        async function eliminarTransaccion(id) {
            if (!confirm("¿Deseas eliminar este registro permanentemente?")) return;
            
            try {
                if (!navigator.onLine) throw new Error("Operación no disponible sin conexión.");
                
                const { error: delTxError } = await db.from('transacciones').delete().eq('id', id);
                if (delTxError) throw delTxError;
                
                // Sincronización inmutable manual de la caché para aliviar latencia de re-fetch
                transaccionesCacheActuales = transaccionesCacheActuales.filter(t => t.id !== id);
                
                mostrarToast('Transacción eliminada');
                await cargarEstadisticas();
            } catch (err) {
                console.error('[Supabase Excepción] Error al eliminar transacción:', err.message);
                mostrarToast('Error al eliminar: ' + err.message, 'error');
            }
        }

        let modoSimuladorEsDiario = true;
        let valorSimuladorBase = 10000;

        const btnSimDiario = document.getElementById('btn-sim-diario');
        const btnSimMensual = document.getElementById('btn-sim-mensual');
        const inputSimValor = document.getElementById('input-simulador-valor');
        const labelSimModo = document.getElementById('label-simulador-modo');

        function actualizarSimulador() {
            let ahorroMensual = 0;
            let ahorroAnual = 0;

            if (modoSimuladorEsDiario) {
                ahorroMensual = valorSimuladorBase * 30;
                ahorroAnual = valorSimuladorBase * 365;
            } else {
                ahorroMensual = valorSimuladorBase;
                ahorroAnual = valorSimuladorBase * 12;
            }

                const targetText3 = document.getElementById('sim-mensual');
    if (targetText3) {
        targetText3.textContent = formatearMoneda(ahorroMensual);
    }
    const targetText4 = document.getElementById('sim-anual');
    if (targetText4) {
        targetText4.textContent = formatearMoneda(ahorroAnual);
    }
}


        if (btnSimDiario && btnSimMensual && inputSimValor) {
            btnSimDiario?.addEventListener('click', () => {
                modoSimuladorEsDiario = true;
                btnSimDiario.className = "px-2.5 py-1 rounded-lg text-[10px] font-bold bg-emerald-500 text-slate-950 cursor-pointer";
                btnSimMensual.className = "px-2.5 py-1 rounded-lg text-[10px] font-bold text-slate-400 cursor-pointer";
                labelSimModo.textContent = "Monto a recortar (Diario)";
                actualizarSimulador();
            });

            btnSimMensual?.addEventListener('click', () => {
                modoSimuladorEsDiario = false;
                btnSimMensual.className = "px-2.5 py-1 rounded-lg text-[10px] font-bold bg-emerald-500 text-slate-950 cursor-pointer";
                btnSimDiario.className = "px-2.5 py-1 rounded-lg text-[10px] font-bold text-slate-400 cursor-pointer";
                labelSimModo.textContent = "Monto a recortar (Mensual)";
                actualizarSimulador();
            });

            inputSimValor?.addEventListener('input', (e) => {
                let raw = e.target.value.replace(/\D/g, '');
                if (!raw) {
                    valorSimuladorBase = 0;
                    e.target.value = '';
                } else {
                    valorSimuladorBase = parseInt(raw);
                    e.target.value = formateadorNumerico.format(valorSimuladorBase);
                }
                actualizarSimulador();
            });
        }


        async function cargarEstadisticas() {
            let session = null;
            try {
                const { data } = await db.auth.getSession();
                session = data?.session;
            } catch (authError) {
                console.warn('[CISO Guard] Error validando sesión para estadísticas:', authError.message);
            }

            if (!session) {
                renderizarDashboardUI(0, 0, 0, [], 0, 0, 0);
                const historial = document.getElementById('historial-transacciones');
                if (historial) historial.textContent = '';
                return;
            }

            const filtro = document.getElementById('filtro-tiempo')?.value || 'mes';
            const elSelectorMes = document.getElementById('selector-mes-excel');
            const ahora = new Date();
            const mesSeleccionado = elSelectorMes && elSelectorMes.value !== "" ? parseInt(elSelectorMes.value) : ahora.getMonth();
            let inicioISO, finISO;
            
            if (filtro === 'dia') {
                const y = ahora.getFullYear(), m = String(ahora.getMonth() + 1).padStart(2, '0'), d = String(ahora.getDate()).padStart(2, '0');
                inicioISO = `${y}-${m}-${d}T00:00:00.000`;
                finISO = `${y}-${m}-${d}T23:59:59.999`;
            } else if (filtro === 'anio') {
                const y = ahora.getFullYear();
                inicioISO = `${y}-01-01T00:00:00.000`;
                finISO = `${y}-12-31T23:59:59.999`;
            } else {
                const y = ahora.getFullYear();
                const m = String(mesSeleccionado + 1).padStart(2, '0');
                const ultDia = new Date(y, mesSeleccionado + 1, 0).getDate();
                inicioISO = `${y}-${m}-01T00:00:00.000`;
                finISO = `${y}-${m}-${String(ultDia).padStart(2, '0')}T23:59:59.999`;
            }

            let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
            let idsEliminadas = JSON.parse(localStorage.getItem('categorias_eliminadas_ids') || '[]');
            categorias = categorias.filter(c => !idsEliminadas.includes(c.id));

            if (navigator.onLine) {
                try {
                    // Filtro explícito para aislamiento multi-tenant en capas cliente
                    let query = db.from('categorias').select('*').order('nombre');
                    if (session) query = query.or(`user_id.is.null,user_id.eq.${session.user.id}`);
                    
                    const { data: catData, error: catError } = await query;
                    // [CISO FIX] Removemos la restricción catData.length > 0 para permitir sobreescritura
                    if (!catError && catData) { 
                        const editadasLocal = categorias.filter(c => c._editado);
                        
                        // [INYECCIÓN] Deduplicación asimétrica para estado Dashboard
                        const mapaDeduplicacion = new Map();
                        [...catData].sort((a, b) => (b.user_id ? 1 : 0) - (a.user_id ? 1 : 0)).forEach(c => {
                            const hash = c.nombre.toLowerCase().trim();
                            if (!mapaDeduplicacion.has(hash)) mapaDeduplicacion.set(hash, c);
                        });
                        const catLimpias = Array.from(mapaDeduplicacion.values());
                        
                        let categoriasFusionadas = catLimpias.filter(c => !idsEliminadas.includes(c.id));
                        
                        // Merge State: Preservar ediciones optimistas (Drafts) ante reloads
                        editadasLocal.forEach(catEditada => {
                            const idx = categoriasFusionadas.findIndex(c => c.id === catEditada.id);
                            if (idx !== -1) categoriasFusionadas[idx] = catEditada;
                            else categoriasFusionadas.push(catEditada);
                        });

                        categorias = categoriasFusionadas;
                        localStorage.setItem('categorias_cache', JSON.stringify(categorias)); 
                    }
                } catch (catError) {
                    console.warn('[CISO Guard] Fallo en red al sincronizar categorías del dashboard:', catError.message);
                }
            }

            // 1. Renderizado en Frío (Latencia Cero)
            const cacheGuardada = JSON.parse(localStorage.getItem(`transacciones_cache_${filtro}`) || '[]');
            const queueOffline = JSON.parse(localStorage.getItem('offline_queue') || '[]');
            const queueFiltrada = queueOffline.filter(t => t.fecha >= inicioISO && t.fecha <= finISO && t.user_id === session.user.id);
            
            let transacciones = [...queueFiltrada, ...cacheGuardada].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
            transaccionesCacheActuales = transacciones;

            // 2. Fetch en Segundo Plano (Stale-While-Revalidate)
            if (navigator.onLine && db) {
                db.from('transacciones')
                    .select('*')
                    .eq('user_id', session.user.id)
                    .gte('fecha', inicioISO)
                    .lte('fecha', finISO)
                    .order('fecha', { ascending: false })
                    .then(({ data, error }) => {
                        if (!error && data) {
                            try {
                                localStorage.setItem(`transacciones_cache_${filtro}`, JSON.stringify(data));
                            } catch (cacheErr) {
                                console.warn('[CISO Storage Alert] Cuota excedida. Purgando cachés antiguas...', cacheErr);
                                localStorage.removeItem('transacciones_cache_anio'); // GC de emergencia
                            }
                            // Si la red trae datos nuevos, actualizamos la memoria y repintamos silenciosamente
                            if (JSON.stringify(data) !== JSON.stringify(cacheGuardada)) {
                                transaccionesCacheActuales = [...queueFiltrada, ...data].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
                                // Invocamos solo la lógica de pintado sin reiniciar todo el ciclo
                                const mapaSilencioso = {};
                                categorias.forEach(c => { mapaSilencioso[c.id] = c; });
                                renderizarListaTransacciones(transaccionesCacheActuales, mapaSilencioso);
                            }
                        }
                    })
                    .catch(err => console.warn('[Sync Silenciosa Fallida]:', err.message));
            }

            let totalGastado = 0;
            let totalIngresado = 0;
            let totalNecesidades = 0;
            let totalDeseos = 0;
            let totalAhorrosYDeudas = 0;

            const totalesCuentas = { 'Efectivo': 0, 'Bancos': 0, 'Tarjetas': 0, 'Transferencia': 0 };

            // [INYECCIÓN] Objeto Phantom para retener la matemática de transacciones huérfanas
            const reporteGastos = { 
                'orphan': { id: 'orphan', nombre: 'Categoría Eliminada', icono: '👻', es_fijo: false, gastado: 0, presupuesto: 0 } 
            };
            const mapaCat = {};
            
            categorias.forEach(c => { 
                mapaCat[c.id] = c;
                if(c.tipo === 'gasto') {
                    reporteGastos[c.id] = { 
                        id: c.id,
                        nombre: escapeHTML(c.nombre), 
                        icono: c.icono, 
                        es_fijo: Boolean(c.es_fijo),
                        gastado: 0,
                        presupuesto: c.presupuesto_base || 400000 
                    }; 
                }
            });

            // Procesamiento en lotes para evitar bloqueos del hilo principal (V8 Optimization)
            transaccionesCacheActuales.forEach(t => {
                // Fallback de integridad para evitar evaporación de dinero en el balance
                const cat = mapaCat[t.categoria_id] || { id: 'orphan', nombre: 'Categoría Eliminada', icono: '👻', tipo: 'gasto', es_fijo: false };
                
                // Blindaje estricto de coerción de tipos para cálculos financieros
                const valor = (Number.parseFloat(t.monto) || 0);
                if (valor <= 0) return; // Auditoría de montos corruptos o negativos fantasma
                
                const isIngreso = cat.tipo === 'ingreso';
                const cuentaNom = t.cuenta || 'Efectivo';

                if (totalesCuentas[cuentaNom] !== undefined) {
                    if (isIngreso) totalesCuentas[cuentaNom] += valor;
                    else totalesCuentas[cuentaNom] -= valor;
                }

                if (isIngreso) {
                    totalIngresado += valor;
                } else if (cat.tipo === 'gasto') {
                    totalGastado += valor;
                    if(reporteGastos[cat.id]) reporteGastos[cat.id].gastado += valor;

                    const nombreUpper = cat.nombre.toUpperCase();
                    const notasUpper = (t.notas || '').toUpperCase();
                    
                    const esAhorroODeuda = nombreUpper.includes('AHORRO') || nombreUpper.includes('META') || nombreUpper.includes('DEUDA') || 
                                           notasUpper.includes('APORTE A META') || notasUpper.includes('ABONO A DEUDA') || notasUpper.includes('AHORRO');
                    
                    const esNecesidadFija = cat.es_fijo || ['ARRIENDO', 'SERVICIOS', 'SUSCRIPCIONES', 'MADRE', 'FACTURAS', 'SEGURO', 'INTERNET', 'MERCADO', 'ALIMENTACIÓN', 'SALUD', 'TRANSPORTE'].some(k => nombreUpper.includes(k));

                    if (esAhorroODeuda) {
                        totalAhorrosYDeudas += valor;
                    } else if (esNecesidadFija) {
                        totalNecesidades += valor;
                    } else {
                        totalDeseos += valor;
                    }
                }
            });

            const targetText5 = document.getElementById('cuenta-efectivo-val');
if (targetText5) {
    targetText5.textContent = formatearMoneda(totalesCuentas['Efectivo']);
}
const targetText6 = document.getElementById('cuenta-bancos-val');
if (targetText6) {
    targetText6.textContent = formatearMoneda(totalesCuentas['Bancos']);
}
const targetText7 = document.getElementById('cuenta-tarjetas-val');
if (targetText7) {
    targetText7.textContent = formatearMoneda(totalesCuentas['Tarjetas']);
}
const targetText8 = document.getElementById('cuenta-transferencia-val');
if (targetText8) {
    targetText8.textContent = formatearMoneda(totalesCuentas['Transferencia']);
}

// [CISO] Purgado de bucles de inicialización redundantes y variables minificadas corruptas.
            // La validación del patrimonio se ejecuta mediante promesas limpias en el bloque inferior.



            db.from('planes').select('*').eq('user_id', session.user.id)
                .then(({ data: planesData, error }) => {
                    if (error) throw error;
                    let totalDeudasPendientes = 0;
                    let totalAhorrosMetas = 0;
                    if (planesData) {
                        planesData.forEach(p => {
                            if (p.tipo === 'deuda') {
                                totalDeudasPendientes += Math.max(0, parseFloat(p.monto) - parseFloat(p.monto_acumulado || 0));
                            }
                            if (p.tipo === 'meta') {
                                totalAhorrosMetas += parseFloat(p.monto_acumulado || 0);
                            }
                        });
                    }
                    const totalEfectivoBancos = totalesCuentas['Efectivo'] + totalesCuentas['Bancos'] + totalesCuentas['Transferencia'];
                    const patrimonioNeto = (totalEfectivoBancos + totalAhorrosMetas) - totalDeudasPendientes;
                    const elPatrimonio = document.getElementById('dash-patrimonio-neto');
                    if (elPatrimonio) elPatrimonio.textContent = formatearMoneda(patrimonioNeto);
                })
                .catch(err => console.warn('Carga de patrimonio omitida por conectividad:', err.message));

            renderizarListaTransacciones(transaccionesCacheActuales, mapaCat);
            renderizarAccesosRapidosInicio(categorias);

            const balanceReal = totalIngresado - totalGastado;
            ultimoBalanceCalculado = balanceReal;
            ultimosIngresosCalculados = totalIngresado;
            ultimosGastosCalculados = totalGastado;
            ultimaMatrizGastos = Object.values(reporteGastos);

            renderizarDashboardUI(balanceReal, totalIngresado, totalGastado, ultimaMatrizGastos, totalNecesidades, totalDeseos, totalAhorrosYDeudas);
        }



        function renderizarListaTransacciones(transacciones, mapaCat) {
            const contenedorHistorial = document.getElementById('historial-transacciones');
if (!contenedorHistorial) return;
contenedorHistorial.textContent = '';

            if(!transacciones || transacciones.length === 0) {
                contenedorHistorial.innerHTML = '<p class="text-slate-500 text-xs text-center py-4">No hay transacciones registradas en este periodo</p>';
                return;
            }

            // Usamos DocumentFragment para evitar colapsar el hilo de renderizado del navegador
            const fragmentoDOM = document.createDocumentFragment();

            transacciones.forEach((t, index) => {
                // [INYECCIÓN] Fallback visual para garantizar la visibilidad de historial huérfano
                const cat = mapaCat[t.categoria_id] || { id: 'orphan', nombre: 'Categoría Eliminada', icono: '👻', tipo: 'gasto' };
                const valor = parseFloat(t.monto);
                const isIngreso = cat.tipo === 'ingreso';

                if (index < 30) {
                    const fila = document.createElement('div');
                    fila.className = `flex justify-between items-center p-4 rounded-2xl border ${isIngreso ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-slate-900/50 border-slate-800/50'}`;
                    
                    const infoDiv = document.createElement('div');
                    infoDiv.className = "flex items-center gap-3";
                    
                    const iconoDiv = document.createElement('div');
                    iconoDiv.className = `w-10 h-10 rounded-full flex items-center justify-center text-lg ${isIngreso ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-300'}`;
                    iconoDiv.textContent = escapeHTML(cat.icono);
                    
                    const textDiv = document.createElement('div');
                    textDiv.className = "flex flex-col";
                    
                    const catSpan = document.createElement('span');
                    catSpan.className = "text-sm font-bold text-white";
                    catSpan.textContent = t.notas ? escapeHTML(t.notas) : escapeHTML(cat.nombre);
                    
                    const notaSpan = document.createElement('span');
                    notaSpan.className = "text-[10px] text-slate-500 font-medium";
                    const fStr = new Date(t.fecha).toLocaleDateString('es-CO', { day:'numeric', month:'short' });
                    notaSpan.textContent = `${escapeHTML(cat.nombre)} • ${fStr} • ${escapeHTML(t.cuenta)}`;
                    
                    textDiv.appendChild(catSpan);
                    textDiv.appendChild(notaSpan);
                    infoDiv.appendChild(iconoDiv);
                    infoDiv.appendChild(textDiv);
                    
                    const valDiv = document.createElement('div');
                    valDiv.className = "flex items-center gap-4";
                    
                    const montoSpan = document.createElement('span');
                    montoSpan.className = `text-sm font-bold tabular-nums ${isIngreso ? 'text-emerald-400' : 'text-white'}`;
                    montoSpan.textContent = `${isIngreso ? '+' : '-'}${formatearMoneda(valor)}`;
                    
                    const btnBorrar = document.createElement('button');
                    btnBorrar.type = "button";
                    /* [NUEVO] Inyección de clase rastreadora y dataset inmutable + a11y */
                    btnBorrar.className = "w-6 h-6 rounded-full flex items-center justify-center bg-slate-800 text-slate-500 hover:text-red-400 hover:bg-slate-700 transition-colors cursor-pointer btn-borrar-tx";
                    btnBorrar.dataset.txid = escapeHTML(t.id);
                    btnBorrar.setAttribute('aria-label', `Eliminar transacción de ${escapeHTML(cat.nombre)} por valor de ${formatearMoneda(valor)}`);
                    btnBorrar.setAttribute('title', 'Eliminar registro permanentemente');
                    btnBorrar.textContent = "✕";
                    
                    valDiv.appendChild(montoSpan);
                    valDiv.appendChild(btnBorrar);
                    fila.appendChild(infoDiv);
                    fila.appendChild(valDiv);
                    fragmentoDOM.appendChild(fila);
                }
            });
            
            contenedorHistorial.appendChild(fragmentoDOM);

            /* [NUEVO] Patrón Singleton: Único Event Listener Global para todo el historial */
            if (!contenedorHistorial.dataset.listenerActivo) {
                contenedorHistorial?.addEventListener('click', (e) => {
                    const btnBorrar = e.target.closest('.btn-borrar-tx');
                    if (btnBorrar && btnBorrar.dataset.txid) {
                        eliminarTransaccion(btnBorrar.dataset.txid);
                    }
                });
                contenedorHistorial.dataset.listenerActivo = 'true';
            }
        }


        let cuentaFiltroActiva = 'todas';

        document.querySelectorAll('.filtro-cta-btn').forEach(btn => {
            btn?.addEventListener('click', (e) => {
                document.querySelectorAll('.filtro-cta-btn').forEach(b => {
                    b.className = "filtro-cta-btn px-3 py-1.5 rounded-full bg-slate-900 border border-slate-800 text-slate-400 font-bold text-[11px] shrink-0 cursor-pointer";
                });
                e.target.className = "filtro-cta-btn px-3 py-1.5 rounded-full bg-emerald-500 text-slate-950 font-bold text-[11px] shrink-0 cursor-pointer";
                cuentaFiltroActiva = e.target.getAttribute('data-cuenta');
                filtrarYRenderizarHistorial();
            });
        });

        const inputBuscarHistorial = document.getElementById('input-buscar-historial');
        if (inputBuscarHistorial) {
            let debounceTimer;
            inputBuscarHistorial?.addEventListener('input', () => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => filtrarYRenderizarHistorial(), 300);
            });
        }

        function filtrarYRenderizarHistorial() {
            const query = (inputBuscarHistorial ? inputBuscarHistorial.value : '').toLowerCase().trim();
            let categorias = JSON.parse(localStorage.getItem('categorias_cache') || '[]');
            let idsEliminadas = JSON.parse(localStorage.getItem('categorias_eliminadas_ids') || '[]');
            categorias = categorias.filter(c => !idsEliminadas.includes(c.id));
            
            const mapaCat = {};
            categorias.forEach(c => { mapaCat[c.id] = c; });

            const filtradas = transaccionesCacheActuales.filter(t => {
                const cat = mapaCat[t.categoria_id] || { nombre: '' };
                const notas = (t.notas || '').toLowerCase();
                const catNombre = cat.nombre.toLowerCase();
                const cuenta = (t.cuenta || '').toLowerCase();
                
                const pasaCuenta = cuentaFiltroActiva === 'todas' || t.cuenta === cuentaFiltroActiva;
                const pasaTexto = !query || notas.includes(query) || catNombre.includes(query) || cuenta.includes(query) || (query.startsWith('#') && notas.includes(query));
                
                return pasaCuenta && pasaTexto;
            });
            renderizarListaTransacciones(filtradas, mapaCat);
        }

        const btnVoz = document.getElementById('btn-voz');
        if (btnVoz) {
            btnVoz?.addEventListener('click', () => {
                const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SpeechRecognition) {
                    mostrarToast('Tu navegador no soporta dictado por voz', 'error');
                    return;
                }
                const recognition = new SpeechRecognition();
                recognition.lang = 'es-ES';
                recognition.start();
                mostrarToast('🎙️ Escuchando... Di el monto o concepto');

                recognition.onresult = (event) => {
                    const textoDictado = event.results[0][0].transcript.toLowerCase();
                    const numerosEnTexto = textoDictado.replace(/\D/g, '');
                    if (numerosEnTexto) {
                        monto = numerosEnTexto;
                        actualizarPantalla();
                        mostrarToast(`Monto detectado: ${formatearMoneda(parseInt(monto))}`);
                    } else {
                        mostrarToast(`Texto: "${textoDictado}". Escribe el número en el teclado.`);
                    }
                };

                recognition.onerror = () => {
                    mostrarToast('No se pudo reconocer el audio', 'error');
                };
            });
        }

        function renderizarDashboardUI(balanceReal, totalIngresado, totalGastado, arrGastos, totalNecesidades = 0, totalDeseos = 0, totalAhorros = 0) {
            let pDisp = totalIngresado > 0 ? ((balanceReal / totalIngresado) * 100).toFixed(0) : 0;
            if(pDisp < 0) pDisp = 0; if(pDisp > 100) pDisp = 100;

            const dIng = document.getElementById('dash-ingresos'); if(dIng) dIng.textContent = `+${formatearMoneda(totalIngresado)}`;
            const dGas = document.getElementById('dash-gastos'); if(dGas) dGas.textContent = `-${formatearMoneda(totalGastado)}`;
            const dBal = document.getElementById('dash-balance'); if(dBal) dBal.textContent = formatearMoneda(balanceReal);
            const dPor = document.getElementById('dash-porcentaje'); if(dPor) dPor.textContent = `${pDisp}%`;
            const dBar = document.getElementById('dash-bar'); if(dBar) dBar.style.width = `${pDisp}%`;

            if (totalIngresado > 0) {
                const necPct = Math.round((totalNecesidades / totalIngresado) * 100);
                const desPct = Math.round((totalDeseos / totalIngresado) * 100);
                const ahoPct = Math.round((totalAhorros / totalIngresado) * 100);
                
                const elNec = document.getElementById('stat-50');
                const elDes = document.getElementById('stat-30');
                const elAho = document.getElementById('stat-20');
                
                if(elNec) { elNec.textContent = `${necPct}%`; elNec.className = `text-xs font-bold ${necPct > 50 ? 'text-red-400' : 'text-white'}`; }
                if(elDes) { elDes.textContent = `${desPct}%`; elDes.className = `text-xs font-bold ${desPct > 30 ? 'text-amber-400' : 'text-white'}`; }
                if(elAho) { elAho.textContent = `${ahoPct}%`; elAho.className = `text-xs font-bold ${ahoPct >= 20 ? 'text-emerald-400' : 'text-slate-300'}`; }
            } else {
                const s50 = document.getElementById('stat-50'); if(s50) s50.textContent = '0%';
                const s30 = document.getElementById('stat-30'); if(s30) s30.textContent = '0%';
                const s20 = document.getElementById('stat-20'); if(s20) s20.textContent = '0%';
            }

            const ahora = new Date();
            const selMes = document.getElementById('selector-mes-excel');
            const mesSeleccionado = parseInt(selMes ? selMes.value : ahora.getMonth());
            const diasTranscurridos = Math.max(1, ahora.getDate());
            
            const promedio = totalGastado / diasTranscurridos;
            const diasDeVidaRestantes = promedio > 0 ? Math.floor(balanceReal / promedio) : 99;

            const dProm = document.getElementById('dash-promedio'); if(dProm) dProm.textContent = formatearMoneda(promedio);
            const dSeg = document.getElementById('dash-seguro'); if(dSeg) dSeg.textContent = formatearMoneda(promedio);
            const dDias = document.getElementById('dash-dias-restantes'); if(dDias) dDias.textContent = balanceReal <= 0 ? '¡Sin fondos!' : `~${diasDeVidaRestantes} días de vida`;

            const ordenados = [...arrGastos].sort((a,b) => b.gastado - a.gastado);
            const dTop = document.getElementById('dash-top-cat'); if(dTop) dTop.textContent = ordenados.length > 0 && ordenados[0].gastado > 0 ? ordenados[0].nombre : 'N/A';

            const matrizContainer = document.getElementById('matriz-presupuesto-excel');
            if (matrizContainer) matrizContainer.textContent = '';
            
            if (!db || !db.auth) return;
            db.auth.getSession().then(({ data, error }) => {
                if (error) throw error;
                const activeSession = data?.session;
                const userId = activeSession ? activeSession.user.id : null;
                
                const renderMatrixWithLimits = (planesLimites = []) => {
                    const mapaLimites = {};
                    planesLimites.forEach(p => { mapaLimites[p.categoria_id] = parseFloat(p.monto); });

                    // [V8 PERFORMANCE] Uso de Fragment para evitar Reflows múltiples en el DOM
                    const fragmentoMatriz = document.createDocumentFragment();

                    ordenados.forEach(item => {
                        const row = document.createElement('div');
                        row.className = "flex flex-col gap-1.5 bg-slate-950/50 p-3.5 rounded-2xl border border-slate-800/80 text-xs";
                        
                        const presupuestoBase = mapaLimites[item.id] || item.presupuesto || 400000;
                        const diferencia = presupuestoBase - item.gastado;
                        const porcentajeUso = presupuestoBase > 0 ? Math.min(150, Math.round((item.gastado / presupuestoBase) * 100)) : 0;
                        
                        let barraColor = "bg-emerald-500";
                        let alertaColor = "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
                        let textoEstado = "Óptimo";

                        if (porcentajeUso >= 80 && porcentajeUso < 100) {
                            barraColor = "bg-amber-500";
                            alertaColor = "text-amber-400 bg-amber-500/10 border-amber-500/20";
                            textoEstado = "Alerta (80%)";
                        } else if (porcentajeUso >= 100) {
                            barraColor = "bg-red-500";
                            alertaColor = "text-red-400 bg-red-500/10 border-red-500/20";
                            textoEstado = "Sobregiro";
                        }

                        row.textContent = `
                            <div class="flex justify-between items-center">
                                <div class="flex items-center gap-2">
                                    <span>${escapeHTML(item.icono)}</span>
                                    <span class="font-bold text-white">${escapeHTML(item.nombre)}</span>
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="text-slate-400">Real: <strong class="text-white tabular-nums">${formatearMoneda(item.gastado)}</strong></span>
                                    <button type="button" class="btn-editar-presupuesto w-6 h-6 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center text-xs transition-colors border border-slate-800 cursor-pointer" aria-label="Editar presupuesto de ${escapeHTML(item.nombre)}" data-catid="${item.id}" data-catnombre="${escapeHTML(item.nombre)}" data-presupuesto="${presupuestoBase}" title="Cambiar presupuesto">⚙️</button>
                                    <span class="text-[9px] font-bold px-2 py-0.5 rounded-full border ${alertaColor}">${textoEstado}</span>
                                </div>
                            </div>
                            <div class="flex justify-between text-[10px] text-slate-500 font-semibold pt-1">
                                <span>Presupuesto: ${formatearMoneda(presupuestoBase)}</span>
                                <span class="${diferencia < 0 ? 'text-red-400 font-bold' : 'text-slate-400'}">Dif: ${formatearMoneda(diferencia)} (${porcentajeUso}%)</span>
                            </div>
                            <div class="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden border border-slate-800">
                                <div class="${barraColor} h-1.5 rounded-full transition-all duration-500" style="width: ${Math.min(100, porcentajeUso)}%"></div>
                            </div>
                        `;
                        fragmentoMatriz.appendChild(row);
                    });
                    
                    matrizContainer.appendChild(fragmentoMatriz);

                    /* [NUEVO] Patrón Singleton de delegación para proteger la memoria RAM en el Dashboard */
                    if (!matrizContainer.dataset.listenerActivo) {
                        matrizContainer?.addEventListener('click', (e) => {
                            const btn = e.target.closest('.btn-editar-presupuesto');
                            if (!btn) return;
                            
                            const catId = btn.getAttribute('data-catid');
                            const catNombre = btn.getAttribute('data-catnombre');
                            const presActual = btn.getAttribute('data-presupuesto');
                            abrirModalEditarPresupuesto(catId, catNombre, presActual);
                        });
                        matrizContainer.dataset.listenerActivo = 'true';
                    }
                };

                if (userId) {
                    db.from('planes').select('*').eq('tipo', 'limite').eq('user_id', userId).then(({ data: planesLimites }) => {
                        renderMatrixWithLimits(planesLimites || []);
                    }).catch(err => {
                        console.warn('[CISO Guard] Carga de límites cancelada por red:', err.message);
                        renderMatrixWithLimits([]);
                    });
                } else {
                    renderMatrixWithLimits([]);
                }
            }).catch(err => {
                console.error('[CISO Guard] Pipeline de matriz abortado (Error de Sesión):', err.message);
            });

            const labelsGrafico = [];
            const dataGrafico = [];
            const contenedorLista = document.getElementById('lista-presupuestos');
            if (contenedorLista) contenedorLista.textContent = '';

            if (totalGastado === 0) {
                renderizarGraficoDonut(['Sin gastos'], [1], formatearMoneda(0), ['#334155']);
                return;
            }

            ordenados.forEach(item => {
                if (item.gastado > 0) { 
                    labelsGrafico.push(item.nombre); 
                    dataGrafico.push(item.gastado); 
                    const pct = Math.round((item.gastado / totalGastado) * 100);
                    
                    const row = document.createElement('div');
                    row.className = "flex justify-between items-center bg-slate-950/50 p-3 rounded-xl border border-slate-800";
                    row.textContent = `
                        <div class="flex items-center gap-3">
                            <span class="text-emerald-400 font-bold text-xs">${pct}%</span>
                            <span class="text-sm font-bold text-white">${escapeHTML(item.nombre)}</span>
                        </div>
                        <span class="text-sm font-bold text-slate-300">${formatearMoneda(item.gastado)}</span>
                    `;
                    contenedorLista.appendChild(row);
                }
            });

            renderizarGraficoDonut(labelsGrafico, dataGrafico, formatearMoneda(totalGastado));
        }

        function renderizarGraficoDonut(labels, data, centerText, customColors = null) {
            const canvasEl = document.getElementById('graficoCategorias');
            if (!canvasEl) return;
            
            if (graficoInstancia && graficoInstancia.data?.datasets?.[0]) {
                // Mutación reactiva controlada: evitamos caída si el dataset se corrompe en memoria
                graficoInstancia.data.labels = labels;
                graficoInstancia.data.datasets[0].data = data;
                if (customColors) graficoInstancia.data.datasets[0].backgroundColor = customColors;
                if (graficoInstancia.options?.plugins?.centerText) {
                    graficoInstancia.options.plugins.centerText.text = centerText;
                }
                graficoInstancia.update();
                return;
            }

            const ctx = canvasEl.getContext('2d');
            // [CISO FIX] Cortocircuito de seguridad si el CDN de Chart.js fue bloqueado o no está en caché
            if (typeof Chart === 'undefined') {
                canvasEl.parentElement.innerHTML = '<p class="text-xs text-slate-500 text-center py-12 border border-dashed border-slate-800 rounded-2xl w-full">Gráfico no disponible offline</p>';
                return;
            }
            
            graficoInstancia = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: customColors || ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#64748b', '#14b8a6'],
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        centerText: { text: centerText }
                    },
                    cutout: '75%'
                }
            });
        }

        function renderizarAccesosRapidosInicio(categorias) {
            const contenedor = document.getElementById('accesos-frecuentes-inicio');
            if (!contenedor) return;
            contenedor.textContent = '';
            
            const catsGastos = categorias.filter(c => c.tipo === 'gasto');
            if (catsGastos.length === 0) return;

            // [PERFORMANCE V8] Delegación de eventos estática mediante Singleton
            if (!contenedor.dataset.listenerRapidoActivo) {
                contenedor.addEventListener('click', (e) => {
                    const btn = e.target.closest('.btn-acceso-rapido');
                    if (!btn) return;
                    if (parseInt(monto) <= 0) {
                        mostrarToast('Digita un monto primero', 'error');
                        return;
                    }
                    guardarTransaccion(btn.dataset.catid, 'Gasto rápido');
                });
                contenedor.dataset.listenerRapidoActivo = 'true';
            }

            const fragmentoDOM = document.createDocumentFragment();
            catsGastos.forEach(cat => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = "btn-acceso-rapido flex items-center gap-1.5 px-3 py-1.5 bg-slate-900/90 border border-slate-800/80 rounded-full text-xs font-semibold text-slate-300 active:scale-95 transition-all shrink-0 cursor-pointer shadow-sm hover:border-emerald-500/40";
                b.dataset.catid = escapeHTML(cat.id);
                b.setAttribute('aria-label', `Acceso rápido para registrar gasto en ${escapeHTML(cat.nombre)}`);
                b.innerHTML = `<span>${escapeHTML(cat.icono)}</span> <span class="max-w-[90px] truncate">${escapeHTML(cat.nombre)}</span>`;
                fragmentoDOM.appendChild(b);
            });
            contenedor.appendChild(fragmentoDOM);
        }

        document.querySelectorAll('.sug-nota-chip').forEach(btn => {
    btn?.addEventListener('click', (e) => {
        const targetInput9 = document.getElementById('input-notas');
        if (targetInput9) {
            targetInput9.value = e.target.textContent;
        }
    });
});


        document.querySelectorAll('.btn-tema').forEach(btn => {
            btn?.addEventListener('click', (e) => {
                const tema = e.currentTarget.getAttribute('data-tema') || 'emerald';
                localStorage.setItem('tema_color_app', tema);
                
                const metaTheme = document.getElementById('meta-theme-color');
                if (tema === 'blue') metaTheme.setAttribute('content', '#3b82f6');
                else if (tema === 'purple') metaTheme.setAttribute('content', '#a855f7');
                else metaTheme.setAttribute('content', '#10b981');

                mostrarToast('Tema de color guardado');
            });
        });

        // Ejecución forzada encapsulada en DOMContentLoaded para inmunidad contra minificación V8
        document.addEventListener('DOMContentLoaded', () => {
            if (navigator.onLine && db) {
                sincronizarCategoriasCache();
            }
            if (db) verificarEstadoSesion();
            verificarSeguridadBiometrico();
            comprobarRolloverMes();

            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('./sw.js')
                    .catch(err => console.warn('[CISO Guard] Error de registro SW:', err));
            }
        });