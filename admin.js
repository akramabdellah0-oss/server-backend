// Admin Dashboard JavaScript
// ===========================

// Configuration - Use relative URL since admin.html is served from server
const API_BASE = window.location.origin;

// State
let adminToken = localStorage.getItem('adminToken') || '';
let autoRefreshLogs = false;
let autoRefreshInterval = null;
let currentDeleteEmail = null;

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // Check if already logged in
    if (adminToken) {
        verifyToken();
    }

    // Setup event listeners
    setupEventListeners();
});

function setupEventListeners() {
    // Login form
    document.getElementById('loginForm').addEventListener('submit', handleLogin);

    // Logout
    document.getElementById('btnLogout').addEventListener('click', handleLogout);

    // Navigation
    document.querySelectorAll('.admin-nav button').forEach(btn => {
        btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
    });

    // Dashboard actions
    document.getElementById('btnRefreshStats').addEventListener('click', loadStats);
    document.getElementById('btnSyncAllUsers').addEventListener('click', syncAllUsers);
    document.getElementById('btnClearLogs').addEventListener('click', clearLogs);

    // Clients actions
    document.getElementById('btnAddClient').addEventListener('click', () => openModal('addClientModal'));
    document.getElementById('btnRefreshClients').addEventListener('click', loadClients);
    document.getElementById('searchClients').addEventListener('input', filterClients);
    document.getElementById('btnConfirmAddClient').addEventListener('click', addClient);
    document.getElementById('btnConfirmDeleteClient').addEventListener('click', confirmDeleteClient);

    // Logs actions
    document.getElementById('btnRefreshLogs').addEventListener('click', loadLogs);
    document.getElementById('btnAutoRefreshLogs').addEventListener('click', toggleAutoRefreshLogs);
    document.getElementById('btnClearLogsPanel').addEventListener('click', clearLogs);
}

// ============================================
// AUTHENTICATION
// ============================================

async function handleLogin(e) {
    e.preventDefault();
    const password = document.getElementById('adminPassword').value;

    try {
        const response = await fetch(`${API_BASE}/api/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        const data = await response.json();

        if (data.success) {
            adminToken = data.token;
            localStorage.setItem('adminToken', adminToken);
            showAdminDashboard();
            showToast('Connexion réussie !', 'success');
        } else {
            showLoginError(data.error || 'Mot de passe incorrect');
        }
    } catch (error) {
        showLoginError('Erreur de connexion au serveur');
        console.error('Login error:', error);
    }
}

async function verifyToken() {
    try {
        const response = await fetch(`${API_BASE}/api/admin/verify`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        if (response.ok) {
            showAdminDashboard();
        } else {
            handleLogout();
        }
    } catch (error) {
        console.error('Token verification error:', error);
    }
}

function handleLogout() {
    adminToken = '';
    localStorage.removeItem('adminToken');
    document.getElementById('adminContainer').classList.remove('show');
    document.getElementById('loginContainer').style.display = 'flex';
    document.getElementById('adminPassword').value = '';
    stopAutoRefresh();
}

function showLoginError(message) {
    const errorDiv = document.getElementById('loginError');
    document.getElementById('loginErrorText').textContent = message;
    errorDiv.classList.add('show');
    setTimeout(() => errorDiv.classList.remove('show'), 5000);
}

function showAdminDashboard() {
    document.getElementById('loginContainer').style.display = 'none';
    document.getElementById('adminContainer').classList.add('show');
    loadStats();
    loadClients();
}

// ============================================
// NAVIGATION
// ============================================

function switchPanel(panelName) {
    // Update nav buttons
    document.querySelectorAll('.admin-nav button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.panel === panelName);
    });

    // Update panels
    document.querySelectorAll('.admin-panel').forEach(panel => {
        panel.classList.remove('active');
    });

    const targetPanel = document.getElementById(`panel${panelName.charAt(0).toUpperCase() + panelName.slice(1)}`);
    if (targetPanel) {
        targetPanel.classList.add('active');
    }

    // Load data for the panel
    if (panelName === 'clients') {
        loadClients();
    } else if (panelName === 'logs') {
        loadLogs();
    } else if (panelName === 'dashboard') {
        loadStats();
    }
}

// ============================================
// STATS
// ============================================

async function loadStats() {
    try {
        const response = await fetch(`${API_BASE}/api/admin/stats`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        if (!response.ok) throw new Error('Failed to load stats');

        const data = await response.json();

        document.getElementById('statTotalUsers').textContent = data.totalUsers || 0;
        document.getElementById('statPremiumUsers').textContent = data.premiumUsers || 0;
        document.getElementById('statUptime').textContent = formatUptime(data.uptime || 0);
        document.getElementById('statMemory').textContent = `${data.memoryMB || 0} MB`;

    } catch (error) {
        console.error('Error loading stats:', error);
        showToast('Erreur lors du chargement des stats', 'error');
    }
}

function formatUptime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

// ============================================
// CLIENTS
// ============================================

let allClients = [];

async function loadClients() {
    try {
        const response = await fetch(`${API_BASE}/api/admin/users`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        if (!response.ok) throw new Error('Failed to load clients');

        const data = await response.json();
        allClients = Object.entries(data.users || {}).map(([email, userData]) => ({
            email,
            ...userData
        }));

        renderClients(allClients);

    } catch (error) {
        console.error('Error loading clients:', error);
        showToast('Erreur lors du chargement des clients', 'error');
    }
}

function renderClients(clients) {
    const tbody = document.getElementById('clientsTableBody');
    const noClientsMsg = document.getElementById('noClientsMessage');

    if (clients.length === 0) {
        tbody.innerHTML = '';
        noClientsMsg.style.display = 'block';
        return;
    }

    noClientsMsg.style.display = 'none';

    tbody.innerHTML = clients.map(client => `
        <tr>
            <td class="user-email">${escapeHtml(client.email)}</td>
            <td>
                <span class="badge badge-${(client.plan || 'free').toLowerCase()}">
                    ${client.plan || 'Free'}
                </span>
            </td>
            <td>
                <span class="badge badge-${client.isPremium ? 'active' : 'inactive'}">
                    ${client.isPremium ? 'Actif' : 'Inactif'}
                </span>
            </td>
            <td>${client.activatedAt ? formatDate(client.activatedAt) : '-'}</td>
            <td class="action-btns">
                <button class="btn btn-secondary btn-sm" onclick="syncClient('${escapeHtml(client.email)}')" title="Synchroniser avec Stripe">
                    <i class="fas fa-sync"></i>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteClient('${escapeHtml(client.email)}')" title="Supprimer">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

function filterClients() {
    const search = document.getElementById('searchClients').value.toLowerCase();
    const filtered = allClients.filter(c =>
        c.email.toLowerCase().includes(search) ||
        (c.plan || '').toLowerCase().includes(search)
    );
    renderClients(filtered);
}

async function addClient() {
    const email = document.getElementById('newClientEmail').value.trim();
    const plan = document.getElementById('newClientPlan').value;

    if (!email) {
        showToast('Veuillez entrer un email', 'error');
        return;
    }

    try {
        const url = plan === 'Free'
            ? `${API_BASE}/api/admin/add-user`
            : `${API_BASE}/api/force-activate?email=${encodeURIComponent(email)}&plan=${plan}`;

        const response = plan === 'Free'
            ? await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminToken}`
                },
                body: JSON.stringify({ email, plan })
            })
            : await fetch(url, {
                headers: { 'Authorization': `Bearer ${adminToken}` }
            });

        const data = await response.json();

        if (data.success || data.user) {
            showToast(`Client ${email} ajouté avec succès !`, 'success');
            closeModal('addClientModal');
            document.getElementById('newClientEmail').value = '';
            document.getElementById('newClientPlan').value = 'Free';
            loadClients();
            loadStats();
        } else {
            showToast(data.error || 'Erreur lors de l\'ajout', 'error');
        }
    } catch (error) {
        console.error('Error adding client:', error);
        showToast('Erreur lors de l\'ajout du client', 'error');
    }
}

function deleteClient(email) {
    currentDeleteEmail = email;
    document.getElementById('deleteClientEmail').textContent = email;
    openModal('deleteClientModal');
}

async function confirmDeleteClient() {
    if (!currentDeleteEmail) return;

    try {
        const response = await fetch(`${API_BASE}/api/admin/users/${encodeURIComponent(currentDeleteEmail)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        const data = await response.json();

        if (data.success) {
            showToast(`Client ${currentDeleteEmail} supprimé !`, 'success');
            closeModal('deleteClientModal');
            currentDeleteEmail = null;
            loadClients();
            loadStats();
        } else {
            showToast(data.error || 'Erreur lors de la suppression', 'error');
        }
    } catch (error) {
        console.error('Error deleting client:', error);
        showToast('Erreur lors de la suppression', 'error');
    }
}

async function syncClient(email) {
    try {
        showToast(`Synchronisation de ${email}...`, 'success');

        const response = await fetch(`${API_BASE}/api/admin/sync-user/${encodeURIComponent(email)}`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        const data = await response.json();

        if (data.success) {
            showToast(`${email} synchronisé: ${data.user?.plan || 'Free'}`, 'success');
            loadClients();
        } else {
            showToast(data.error || 'Erreur de synchronisation', 'error');
        }
    } catch (error) {
        console.error('Error syncing client:', error);
        showToast('Erreur de synchronisation', 'error');
    }
}

async function syncAllUsers() {
    try {
        showToast('Synchronisation de tous les utilisateurs...', 'success');

        const response = await fetch(`${API_BASE}/api/admin/sync-all`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        const data = await response.json();

        if (data.success) {
            showToast(`${data.synced || 0} utilisateurs synchronisés !`, 'success');
            loadClients();
            loadStats();
        } else {
            showToast(data.error || 'Erreur de synchronisation', 'error');
        }
    } catch (error) {
        console.error('Error syncing all users:', error);
        showToast('Erreur de synchronisation globale', 'error');
    }
}

// ============================================
// LOGS
// ============================================

async function loadLogs() {
    try {
        const response = await fetch(`${API_BASE}/api/admin/logs`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        if (!response.ok) throw new Error('Failed to load logs');

        const data = await response.json();
        renderLogs(data.logs || []);

    } catch (error) {
        console.error('Error loading logs:', error);
    }
}

function renderLogs(logs) {
    const container = document.getElementById('logsContainer');
    const noLogsMsg = document.getElementById('noLogsMessage');

    if (logs.length === 0) {
        container.innerHTML = '';
        container.appendChild(noLogsMsg);
        noLogsMsg.style.display = 'block';
        return;
    }

    noLogsMsg.style.display = 'none';

    container.innerHTML = logs.map(log => {
        let logClass = '';
        if (log.message.includes('❌') || log.message.toLowerCase().includes('error')) {
            logClass = 'error';
        } else if (log.message.includes('✅') || log.message.toLowerCase().includes('success')) {
            logClass = 'success';
        } else if (log.message.includes('⚠️') || log.message.toLowerCase().includes('warning')) {
            logClass = 'warning';
        }

        return `
            <div class="log-entry ${logClass}">
                <span class="log-time">${formatLogTime(log.timestamp)}</span>
                <span class="log-message">${escapeHtml(log.message)}</span>
            </div>
        `;
    }).join('');

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

function formatLogTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

function toggleAutoRefreshLogs() {
    const btn = document.getElementById('btnAutoRefreshLogs');

    if (autoRefreshLogs) {
        stopAutoRefresh();
        btn.innerHTML = '<i class="fas fa-play"></i> Auto-Refresh';
        btn.classList.remove('btn-success');
        btn.classList.add('btn-secondary');
    } else {
        autoRefreshLogs = true;
        autoRefreshInterval = setInterval(loadLogs, 3000);
        btn.innerHTML = '<i class="fas fa-pause"></i> Arrêter';
        btn.classList.remove('btn-secondary');
        btn.classList.add('btn-success');
        loadLogs();
    }
}

function stopAutoRefresh() {
    autoRefreshLogs = false;
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
}

async function clearLogs() {
    try {
        await fetch(`${API_BASE}/api/admin/logs`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${adminToken}` }
        });

        document.getElementById('logsContainer').innerHTML = `
            <div class="empty-state" id="noLogsMessage">
                <i class="fas fa-scroll"></i>
                <h3>Aucun log disponible</h3>
                <p>Les logs du serveur apparaîtront ici</p>
            </div>
        `;

        showToast('Logs vidés !', 'success');
    } catch (error) {
        console.error('Error clearing logs:', error);
    }
}

// ============================================
// MODALS
// ============================================

function openModal(modalId) {
    document.getElementById(modalId).classList.add('show');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

// Close modal on outside click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('show');
    }
});

// ============================================
// TOAST NOTIFICATIONS
// ============================================

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const icon = toast.querySelector('i');

    document.getElementById('toastMessage').textContent = message;

    toast.classList.remove('success', 'error');
    toast.classList.add(type);

    icon.className = type === 'success' ? 'fas fa-check-circle' : 'fas fa-exclamation-circle';

    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

// ============================================
// UTILITIES
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}
