// KIU WEATHER STATION - Real-Time Dashboard Script
// MQTT Configuration with fallback options
const MQTT_CONFIG = {
    host: "smartrantch.redirectme.net",
    port: 9043,
    path: "/mqtt",
    topic: "devices/station1/data",
    useSSL: true
};

// Alternative connection options (try different ports if needed)
const ALTERNATIVE_PORTS = [9043, 8083, 8084, 9001, 1884];

// Station location (KIU Kansanga, Kampala)
const STATION_LAT = 0.2947;
const STATION_LNG = 32.6036;

// Initialize data structure with realistic default values
let stationData = {
    temp: 27.9, 
    hum: 62.0, 
    pres: 882.0, 
    rain: 0.0,
    light: 8500.0, 
    solarV: 4.2, 
    wind: 12.5, 
    windDir: 135,
    batP: 78
};

// Global variables
let mapInstance = null;
let mapMarker = null;
let mqttClient = null;
let reconnectTimeout = null;
let isConnected = false;
let fallbackInterval = null;
let lastMqttUpdate = Date.now();
let currentPortIndex = 0;
let connectionAttempts = 0;
let demoMode = false;
let chartTempBar = null;
let chartHumBar = null;
let chartPresBar = null;
let chartRainBar = null;
let refreshTimer = null;
let recordedHistory = [];
const MAX_LOCAL_RECORDS = 200;
const HISTORY_KEY = 'kiu_weather_history';
const API_ROOT = window.location.protocol === 'file:' ? 'http://localhost:3000/api' : '/api';

// --- NEW: auto-posting throttle state ---
let lastPostTime = 0;
const POST_INTERVAL_MS = 2000; // minimum interval between posts to server
const AUTO_REFRESH_MS = 300000; // refresh table and charts every 5 minutes

// Load saved data from localStorage
try {
    const saved = localStorage.getItem('kiu_weather_data');
    if (saved) {
        const parsed = JSON.parse(saved);
        stationData = { ...stationData, ...parsed };
    }
} catch(e) {
    console.warn("localStorage read error:", e);
}

try {
    const history = localStorage.getItem(HISTORY_KEY);
    if (history) {
        recordedHistory = JSON.parse(history);
    }
} catch(e) {
    console.warn("local history read error:", e);
}

function saveHistory() {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(recordedHistory));
    } catch (e) {
        console.warn("local history save error:", e);
    }
}

function recordCurrentReading() {
    const row = buildServerPayload();
    row.timestamp = Date.now();
    const last = recordedHistory[0];
    if (last && Math.abs(row.timestamp - last.timestamp) < 1000) {
        return;
    }
    recordedHistory.unshift(row);
    if (recordedHistory.length > MAX_LOCAL_RECORDS) {
        recordedHistory.pop();
    }
    saveHistory();
}

// Helper: Update all UI elements
function updateUI(data) {
    // Update numeric fields
    const setVal = (id, value, decimals = 1) => {
        const el = document.getElementById(id);
        if (el) {
            let num = (typeof value === 'number') ? value : parseFloat(value);
            if (isNaN(num)) num = 0;
            el.innerText = num.toFixed(decimals);
        }
    };
    
    setVal('temp', data.temp);
    setVal('hum', data.hum);
    setVal('pres', data.pres);
    setVal('rain', data.rain);
    setVal('light', data.light);
    setVal('solarV', data.solarV);
    setVal('wind', data.wind, 1);
    
    // Update battery
    const batPerc = (data.batP !== undefined && !isNaN(data.batP)) ? data.batP : 78;
    const batFillDiv = document.getElementById('batFill');
    const batTextSpan = document.getElementById('batP_text');
    
    if (batFillDiv) {
        batFillDiv.style.width = Math.min(100, Math.max(0, batPerc)) + "%";
    }
    if (batTextSpan) {
        batTextSpan.innerText = batPerc.toFixed(0);
    }
    
    // Update wind direction
    const windDir = (data.windDir !== undefined) ? data.windDir : 0;
    const arrowDiv = document.getElementById('arrow');
    const dirLabel = document.getElementById('windDirLabel');
    
    if (arrowDiv) {
        arrowDiv.style.transform = `rotate(${windDir}deg)`;
    }
    if (dirLabel) {
        const dirText = getWindDirection(windDir);
        dirLabel.innerHTML = `Direction: ${dirText} (${Math.round(windDir)}°)`;
    }
    
    // Update map popup if available
    if (mapMarker && mapInstance) {
        const tempC = (data.temp || 0).toFixed(1);
        const humVal = (data.hum || 0).toFixed(0);
        const windSpd = (data.wind || 0).toFixed(1);
        const solar = (data.solarV || 0).toFixed(1);
        mapMarker.bindPopup(`
            <b>🏫 KIU Weather Station</b><br>
            🌡️ ${tempC}°C &nbsp; 💧 ${humVal}%<br>
            🌬️ ${windSpd} km/h &nbsp; ☀️ ${solar}V<br>
            📡 ${demoMode ? 'DEMO MODE' : 'LIVE'}
        `).openPopup();
    }
    recordCurrentReading();
}

// Get cardinal direction from degrees
function getWindDirection(deg) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 
                       'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(((deg % 360) / 22.5)) % 16;
    return directions[index];
}

// Initialize Leaflet Map (Fixed tile alignment)
function initMap() {
    if (mapInstance) return;
    
    const mapDiv = document.getElementById('map');
    if (!mapDiv) return;
    
    // Create map centered at KIU Kansanga
    mapInstance = L.map('map').setView([STATION_LAT, STATION_LNG], 15);
    
    // Use CartoDB light tiles for better visibility
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; CartoDB',
        subdomains: 'abcd',
        maxZoom: 19,
        minZoom: 12
    }).addTo(mapInstance);
    
    // Create custom marker with pulsing effect
    mapMarker = L.circleMarker([STATION_LAT, STATION_LNG], {
        radius: 12,
        fillColor: "#38bdf8",
        color: "#ffffff",
        weight: 3,
        fillOpacity: 0.85,
        opacity: 1,
        interactive: true
    }).addTo(mapInstance);
    
    mapMarker.bindPopup(`
        <b>KIU WEATHER STATION</b><br>
        Loading realtime data...
    `).openPopup();
    
    // CRITICAL FIX: Force map to recalculate size after load
    setTimeout(() => {
        if (mapInstance) {
            mapInstance.invalidateSize(true);
            mapInstance.setView([STATION_LAT, STATION_LNG], 15);
        }
    }, 200);
    
    // Additional fix when tiles load
    mapInstance.on('load', () => {
        setTimeout(() => {
            if (mapInstance) mapInstance.invalidateSize();
        }, 100);
    });
    
    // Handle window resize
    window.addEventListener('resize', () => {
        if (mapInstance) mapInstance.invalidateSize();
    });
}

// Update connection status display
function updateConnectionStatus(connected, message = null) {
    const statusDiv = document.getElementById('status');
    if (!statusDiv) return;
    
    if (connected) {
        statusDiv.className = "connected";
        statusDiv.innerText = message || "CONNECTED - LIVE";
    } else {
        statusDiv.className = "disconnected";
        statusDiv.innerText = message || (demoMode ? "DEMO MODE - SIMULATED" : "RECONNECTING...");
    }
}

// Load admin dashboard stats
async function loadAdmin() {
    const adminStatsDiv = document.getElementById('adminStats');
    if (!adminStatsDiv) return;

    adminStatsDiv.innerHTML = `
        <div id="feedbackStatsContainer" style="margin-bottom:20px; padding:14px; background:rgba(255,255,255,0.04); border-radius:16px; border:1px solid rgba(255,255,255,0.08);">
            <p id="feedbackStats" style="color:#a5f3fc; font-weight:500; margin:0;">Loading respondent stats...</p>
        </div>
        <form id="feedbackForm" class="feedback-form">
            <div class="form-row">
                <label>Name
                    <input id="fbName" type="text" placeholder="Full name" required>
                </label>
            </div>
            <div class="form-row">
                <label>Email
                    <input id="fbEmail" type="email" placeholder="Email address">
                </label>
            </div>
            <div class="form-row">
                <label>Affiliation
                    <input id="fbAffiliation" type="text" placeholder="Department, role, or organization">
                </label>
            </div>
            <div class="form-row">
                <label>Comment
                    <textarea id="fbComment" placeholder="What do you think about the system?" required></textarea>
                </label>
            </div>
            <div class="form-row">
                <label>Advice to admin
                    <textarea id="fbAdvice" placeholder="Any advice or suggestions for the admin"></textarea>
                </label>
            </div>
            <button id="feedbackSubmitBtn" type="submit">Send Feedback</button>
        </form>
    `;

    const form = document.getElementById('feedbackForm');
    if (form) {
        form.addEventListener('submit', handleFeedbackSubmit);
    }

    // Load and display feedback stats
    loadFeedbackStats();
    
    // Auto-refresh stats every 5 seconds
    if (window.feedbackStatsTimer) clearInterval(window.feedbackStatsTimer);
    window.feedbackStatsTimer = setInterval(loadFeedbackStats, 5000);
}

async function loadFeedbackStats() {
    try {
        const res = await fetch(`${API_ROOT}/feedback/stats`);
        if (!res.ok) throw new Error('Failed to fetch feedback stats');
        const stats = await res.json();
        
        const statsDiv = document.getElementById('feedbackStats');
        if (statsDiv) {
            const totalRespondents = stats.total_respondents || 0;
            const targetRespondents = 100; // Target goal for respondents
            const percentage = Math.round((totalRespondents / targetRespondents) * 100);
            const displayPercentage = Math.min(100, percentage); // Cap at 100% for display
            
            let html = `<div style="margin-bottom: 8px;">
                <strong>📊 Respondent Progress:</strong> <span style="color:#38bdf8;">${percentage}%</span> (${totalRespondents}/${targetRespondents})
            </div>
            <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin-bottom: 8px;">
                <div style="width: ${displayPercentage}%; height: 100%; background: linear-gradient(90deg, #38bdf8, #06b6d4); transition: width 0.3s ease;"></div>
            </div>
            <div style="font-size: 13px; color: #94a3b8;">
                <strong>Total Feedback:</strong> ${stats.total_feedback || 0}
            </div>`;
            
            if (stats.recent_respondents && stats.recent_respondents.length > 0) {
                const names = stats.recent_respondents.slice(0, 5).map(r => r.name).join(', ');
                html += `<small style="color:#cbd5e1; margin-top:6px; display:block;">Recent: ${names}</small>`;
            }
            statsDiv.innerHTML = html;
        }
    } catch (err) {
        console.warn('loadFeedbackStats error', err);
    }
}

async function handleFeedbackSubmit(event) {
    event.preventDefault();
    const name = document.getElementById('fbName')?.value.trim() || '';
    const email = document.getElementById('fbEmail')?.value.trim() || '';
    const affiliation = document.getElementById('fbAffiliation')?.value.trim() || '';
    const comment = document.getElementById('fbComment')?.value.trim() || '';
    const advice = document.getElementById('fbAdvice')?.value.trim() || '';
    const feedbackMessage = document.getElementById('feedbackMessage');

    if (!name || !comment) {
        if (feedbackMessage) feedbackMessage.innerText = 'Please provide your name and comment before submitting.';
        return;
    }

    const payload = {
        name,
        email,
        affiliation,
        comment,
        advice,
        submitted_at: Date.now()
    };

    try {
        // Post to server first
        const res = await fetch(`${API_ROOT}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error('Failed to submit feedback');
        const result = await res.json();
        
        if (feedbackMessage) {
            feedbackMessage.innerText = 'Thank you for your feedback! Your response has been submitted.';
        }
        
        // Also save locally as backup
        saveFeedbackLocally(payload);
        
        // Refresh stats immediately
        loadFeedbackStats();
        
    } catch (e) {
        console.warn('handleFeedbackSubmit error', e);
        if (feedbackMessage) feedbackMessage.innerText = 'Failed to submit feedback. Please try again later.';
        // Still save locally as fallback
        saveFeedbackLocally(payload);
    }
    
    const form = document.getElementById('feedbackForm');
    if (form) form.reset();
}

async function saveFeedbackLocally(entry) {
    try {
        const stored = localStorage.getItem('kiu_feedback') || '[]';
        const existing = JSON.parse(stored);
        existing.unshift(entry);
        localStorage.setItem('kiu_feedback', JSON.stringify(existing));
        return true;
    } catch (e) {
        console.warn('saveFeedbackLocally error', e);
        return false;
    }
}



// Demo mode - simulate realistic environmental data
function startDemoMode() {
    console.log("Starting DEMO MODE with realistic data simulation");
    demoMode = true;
    updateConnectionStatus(false, "DEMO MODE - SIMULATED");
    
    if (fallbackInterval) clearInterval(fallbackInterval);
    
    fallbackInterval = setInterval(() => {
        // Simulate realistic environmental variations
        const now = new Date();
        const hour = now.getHours();
        
        // Temperature varies based on time of day (hotter during day)
        let baseTemp = 24;
        if (hour > 8 && hour < 18) {
            baseTemp = 28 + Math.sin((hour - 12) * Math.PI / 12) * 3;
        }
        stationData.temp = +(baseTemp + (Math.random() - 0.5) * 1.5).toFixed(1);
        
        // Humidity inversely related to temperature
        stationData.hum = Math.min(85, Math.max(45, 70 - (stationData.temp - 24) * 1.2 + (Math.random() - 0.5) * 5));
        
        // Pressure with slight variations
        stationData.pres = +(882 + (Math.random() - 0.5) * 2.5).toFixed(0);
        
        // Rainfall simulation (mostly 0, occasional spikes)
        if (Math.random() < 0.05) {
            stationData.rain = +(Math.random() * 25).toFixed(1);
        } else {
            stationData.rain = Math.max(0, stationData.rain - (Math.random() * 2));
        }
        
        // Solar potential based on daylight hours
        if (hour > 6 && hour < 19) {
            stationData.solarV = +(4.5 * Math.sin((hour - 12) * Math.PI / 14) + (Math.random() - 0.5) * 0.5).toFixed(1);
            stationData.light = Math.floor(8000 * Math.sin((hour - 12) * Math.PI / 14) + (Math.random() - 0.5) * 500);
        } else {
            stationData.solarV = +(0.2 + Math.random() * 0.3).toFixed(1);
            stationData.light = Math.floor(50 + Math.random() * 100);
        }
        
        stationData.light = Math.max(0, Math.min(12000, stationData.light));
        stationData.solarV = Math.max(0, Math.min(5.5, stationData.solarV));
        
        // Wind speed and direction
        stationData.wind = +(8 + Math.random() * 15 + Math.sin(hour * Math.PI / 12) * 5).toFixed(1);
        stationData.windDir = (stationData.windDir + (Math.random() - 0.5) * 15) % 360;
        if (stationData.windDir < 0) stationData.windDir += 360;
        
        // Battery slowly discharges
        stationData.batP = Math.max(15, stationData.batP - (Math.random() * 0.1));
        
        // Save to localStorage
        localStorage.setItem('kiu_weather_data', JSON.stringify(stationData));
        
        // Update UI
        updateUI(stationData);
        
        // Update last update time
        lastMqttUpdate = Date.now();
        
        // NEW: persist simulated reading to server (throttled)
        postReading(buildServerPayload());
        
    }, 3000); // Update every 3 seconds for smooth demo
}

// Initialize MQTT Connection with fallback ports
function initMQTT() {
    if (mqttClient && mqttClient.isConnected && mqttClient.isConnected()) {
        console.log("MQTT already connected");
        return;
    }
    
    // If too many attempts, switch to demo mode
    if (connectionAttempts > 5) {
        console.log("Max connection attempts reached, switching to demo mode");
        startDemoMode();
        return;
    }
    
    const currentPort = ALTERNATIVE_PORTS[currentPortIndex];
    const clientId = "KIU_DASH_" + Math.random().toString(36).substring(2, 10);
    
    console.log(`Attempting MQTT connection to ${MQTT_CONFIG.host}:${currentPort}${MQTT_CONFIG.path}`);
    
    try {
        mqttClient = new Paho.Client(MQTT_CONFIG.host, currentPort, MQTT_CONFIG.path, clientId);
        
        mqttClient.onConnectionLost = (response) => {
            console.warn(`MQTT connection lost on port ${currentPort}:`, response && response.errorMessage);
            isConnected = false;
            updateConnectionStatus(false);
            
            // Try next port or retry
            currentPortIndex = (currentPortIndex + 1) % ALTERNATIVE_PORTS.length;
            connectionAttempts++;
            
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(() => {
                if (!isConnected) initMQTT();
            }, 3000);
        };
        
        mqttClient.onMessageArrived = (message) => {
            try {
                const payload = JSON.parse(message.payloadString);
                stationData = { ...stationData, ...payload };

                if (payload.windDir !== undefined) stationData.windDir = payload.windDir;
                if (payload.batP !== undefined) stationData.batP = payload.batP;

                lastMqttUpdate = Date.now();
                localStorage.setItem('kiu_weather_data', JSON.stringify(stationData));
                updateUI(stationData);

                // If we received data, reset connection attempts
                connectionAttempts = 0;

                // NEW: persist reading to server (throttled)
                postReading(buildServerPayload());

            } catch (err) {
                console.error("MQTT parse error:", err);
            }
        };
        
        const connectOptions = {
            onSuccess: () => {
                console.log(`MQTT connected successfully to ${MQTT_CONFIG.host}:${currentPort}`);
                isConnected = true;
                demoMode = false;
                updateConnectionStatus(true);
                mqttClient.subscribe(MQTT_CONFIG.topic);
                
                // Stop fallback if running
                if (fallbackInterval) {
                    clearInterval(fallbackInterval);
                    fallbackInterval = null;
                }
                
                // Reset connection attempts on success
                connectionAttempts = 0;
                currentPortIndex = 0;
            },
            onFailure: (err) => {
                console.error(`MQTT connection failed on port ${currentPort}:`, err && err.errorMessage);
                isConnected = false;
                
                // Try next port
                currentPortIndex = (currentPortIndex + 1) % ALTERNATIVE_PORTS.length;
                connectionAttempts++;
                
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => {
                    if (!isConnected && connectionAttempts < 6) {
                        initMQTT();
                    } else if (connectionAttempts >= 6) {
                        startDemoMode();
                    }
                }, 2000);
            },
            useSSL: MQTT_CONFIG.useSSL,
            timeout: 10,
            keepAliveInterval: 30
        };
        
        mqttClient.connect(connectOptions);
        
    } catch (error) {
        console.error("MQTT client creation error:", error);
        connectionAttempts++;
        
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
            if (connectionAttempts < 6) {
                initMQTT();
            } else {
                startDemoMode();
            }
        }, 2000);
    }
}

// --- NEW: multi-view UI helpers ---
function showView(name) {
    const views = document.querySelectorAll('.view');
    views.forEach(v => v.style.display = 'none');
    const el = document.getElementById('view-' + name);
    if (el) el.style.display = 'block';

    const navButtons = document.querySelectorAll('.nav-btn');
    navButtons.forEach(btn => {
        if (btn.getAttribute('data-view') === name) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // invalidate map if returning to overview
    if (name === 'overview') setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 200);
}

// attach nav buttons
document.addEventListener('DOMContentLoaded', () => {
	// ensure nav buttons attach after DOM load
	const navButtons = document.querySelectorAll('.nav-btn');
	navButtons.forEach(btn => {
		btn.addEventListener('click', (e) => {
			const view = btn.getAttribute('data-view');
			showView(view);
			if (view === 'table') loadTable();
			if (view === 'charts') loadCharts();
			if (view === 'admin') loadAdmin();
		});
	});

	// Table refresh
	const tableRefresh = document.getElementById('tableRefreshBtn');
	if (tableRefresh) tableRefresh.addEventListener('click', () => loadTable());

	// Charts refresh
	const chartsRefresh = document.getElementById('chartsRefreshBtn');
	if (chartsRefresh) chartsRefresh.addEventListener('click', () => loadCharts());

	// Admin buttons
	const btnAgg = document.getElementById('btnRunAggregate');
	if (btnAgg) btnAgg.addEventListener('click', async () => {
		try {
			btnAgg.disabled = true;
			const res = await fetch(`${API_ROOT}/admin/aggregate`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ daysAgo: 1 }) });
			const j = await res.json();
			document.getElementById('adminMsg').innerText = 'Aggregation completed for ' + (j.day || '');
		} catch (e) {
			document.getElementById('adminMsg').innerText = 'Aggregation failed';
		} finally { btnAgg.disabled = false; loadAdmin(); }
	});
	const btnClear = document.getElementById('btnClearSensor');
	if (btnClear) btnClear.addEventListener('click', async () => {
		if (!confirm('Clear all sensor_data? This cannot be undone.')) return;
		btnClear.disabled = true;
		try {
			const res = await fetch(`${API_ROOT}/admin/clear`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tables: ['sensor_data'] })});
			const j = await res.json();
			document.getElementById('adminMsg').innerText = 'Clear result: ' + JSON.stringify(j.results || j);
		} catch(e) {
			document.getElementById('adminMsg').innerText = 'Clear failed';
		} finally { btnClear.disabled = false; loadAdmin(); }
	});
});

// --- NEW: Table loader ---
async function loadTable(limit = 200) {
	const tbody = document.getElementById('tableResultsBody');
	if (!tbody) return;
	tbody.innerHTML = '';

	const live = getCurrentRow();
	let rows = [];
	let usedFallback = false;

	try {
		const res = await fetch(`${API_ROOT}/data?limit=${limit}`);
		if (!res.ok) throw new Error('Failed to fetch server data');
		rows = await res.json();
		if (!rows.length && recordedHistory.length) {
			rows = recordedHistory.slice(0, limit);
			usedFallback = true;
		}
	} catch (e) {
		console.warn('loadTable error', e);
		if (recordedHistory.length) {
			rows = recordedHistory.slice(0, limit);
			usedFallback = true;
		}
	}

	let firstTimestamp = rows.length ? (rows[0].timestamp || 0) : 0;
	if (rows.length === 0 || Math.abs(live.timestamp - firstTimestamp) > 2000) {
		const trLive = document.createElement('tr');
		trLive.style.fontWeight = '700';
		trLive.innerHTML = `<td>${new Date(live.timestamp).toLocaleString()} (live)</td><td>${live.temp ?? '--'}</td><td>${live.hum ?? '--'}</td><td>${live.pres ?? '--'}</td><td>${live.rain ?? '--'}</td><td>${live.wind ?? '--'}</td>`;
		tbody.appendChild(trLive);
	}

	rows.forEach(r => {
		const tr = document.createElement('tr');
		const ageMs = Date.now() - (r.timestamp || 0);
		const label = getRelativeTimeLabel(ageMs);
		const ts = `${new Date(r.timestamp).toLocaleString()}${label ? ` · ${label}` : ''}`;
		if (ageMs <= AUTO_REFRESH_MS) {
			tr.classList.add('recent-row');
		}
		tr.innerHTML = `<td>${ts}</td><td>${r.temp ?? '--'}</td><td>${r.hum ?? '--'}</td><td>${r.pres ?? '--'}</td><td>${r.rain ?? '--'}</td><td>${r.wind ?? '--'}</td>`;
		tbody.appendChild(tr);
	});

	if (usedFallback && rows.length === 0) {
		const emptyNotice = document.createElement('tr');
		emptyNotice.innerHTML = `<td colspan="6" style="color:#94a3b8; text-align:center; padding:18px;">No data found yet — displaying live reading only.</td>`;
		tbody.appendChild(emptyNotice);
	}
}

function getRelativeTimeLabel(ageMs) {
	if (ageMs < 0) return '';
	const seconds = Math.round(ageMs / 1000);
	if (seconds < 10) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	return `${minutes}m ago`;
}

function getCurrentView() {
    const activeBtn = document.querySelector('.nav-btn.active');
    return activeBtn ? activeBtn.getAttribute('data-view') : 'overview';
}

function refreshVisibleView() {
    const currentView = getCurrentView();
    if (currentView === 'table') {
        loadTable();
    } else if (currentView === 'charts') {
        loadCharts();
    }
}

function scheduleAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshVisibleView, AUTO_REFRESH_MS);
    refreshVisibleView();
}

// --- NEW: helper to create a current/live row matching server row shape ---
function getCurrentRow() {
	return {
		id: 0,
		timestamp: Date.now(),
		temp: Number.isFinite(stationData.temp) ? stationData.temp : null,
		hum: Number.isFinite(stationData.hum) ? stationData.hum : null,
		pres: Number.isFinite(stationData.pres) ? stationData.pres : null,
		rain: Number.isFinite(stationData.rain) ? stationData.rain : null,
		wind: Number.isFinite(stationData.wind) ? stationData.wind : null,
		solarV: Number.isFinite(stationData.solarV) ? stationData.solarV : null,
		light: Number.isFinite(stationData.light) ? stationData.light : null,
		battery: Number.isFinite(stationData.batP) ? stationData.batP : null
	};
}

// --- PATCHED: loadCharts shows last 7 days for simplicity ---
async function loadCharts(days = 7) {
	let rows = [];
	let usedFallback = false;

	try {
		const res = await fetch(`${API_ROOT}/daily?limit=${days}`);
		if (!res.ok) throw new Error('Failed to fetch daily data');
		rows = await res.json(); // newest-first
		if (!rows.length) {
			rows = buildDailySummariesFromHistory(days);
			usedFallback = true;
		}
	} catch (e) {
		console.warn('loadCharts error', e);
		rows = buildDailySummariesFromHistory(days);
		usedFallback = true;
	}

	const data = rows.reverse();
	const labels = data.map(d => {
		const date = new Date(d.day);
		return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	});
	const avgTemps = data.map(d => +(d.avg_temp || 0).toFixed(1));
	const avgHums = data.map(d => +(d.avg_hum || 0).toFixed(1));
	const avgPressures = data.map(d => +(d.avg_pres || 0).toFixed(0));
	const totalRains = data.map(d => +(d.total_rain || 0).toFixed(1));

	const todayLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

	if (labels.length === 0 || labels[labels.length - 1] !== todayLabel) {
		labels.push(todayLabel);
		avgTemps.push(Number.isFinite(stationData.temp) ? +stationData.temp.toFixed(1) : 0);
		avgHums.push(Number.isFinite(stationData.hum) ? +stationData.hum.toFixed(1) : 0);
		avgPressures.push(Number.isFinite(stationData.pres) ? +stationData.pres.toFixed(0) : 0);
		totalRains.push(Number.isFinite(stationData.rain) ? +stationData.rain.toFixed(1) : 0);
	}

	const ctxT = document.getElementById('barTemp').getContext('2d');
	if (!chartTempBar) {
		chartTempBar = new Chart(ctxT, {
			type: 'bar',
			data: {
				labels,
				datasets: [{
					label: 'Avg Temperature (°C)',
					data: avgTemps,
					backgroundColor: 'rgba(248, 113, 113, 0.8)',
					borderColor: 'rgba(248, 113, 113, 1)',
					borderWidth: 2,
					borderRadius: 6,
					borderSkipped: false,
					hoverBackgroundColor: 'rgba(248, 113, 113, 1)'
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: {
					legend: { display: false },
					tooltip: {
						backgroundColor: 'rgba(15, 23, 42, 0.95)',
						titleColor: '#f8fafc',
						bodyColor: '#cbd5e1',
						borderColor: 'rgba(56, 189, 248, 0.5)',
						borderWidth: 1,
						cornerRadius: 8,
						displayColors: false
					}
				},
				scales: {
					y: { grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#94a3b8', font: { size: 12 } } },
					x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } }
				}
			}
		});
	} else {
		chartTempBar.data.labels = labels;
		chartTempBar.data.datasets[0].data = avgTemps;
		chartTempBar.update();
	}

	const ctxH = document.getElementById('barHum').getContext('2d');
	if (!chartHumBar) {
		chartHumBar = new Chart(ctxH, {
			type: 'bar',
			data: {
				labels,
				datasets: [{
					label: 'Avg Humidity (%)',
					data: avgHums,
					backgroundColor: 'rgba(34, 211, 238, 0.8)',
					borderColor: 'rgba(34, 211, 238, 1)',
					borderWidth: 2,
					borderRadius: 6,
					borderSkipped: false,
					hoverBackgroundColor: 'rgba(34, 211, 238, 1)'
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: {
					legend: { display: false },
					tooltip: {
						backgroundColor: 'rgba(15, 23, 42, 0.95)',
						titleColor: '#f8fafc',
						bodyColor: '#cbd5e1',
						borderColor: 'rgba(34, 211, 238, 0.5)',
						borderWidth: 1,
						cornerRadius: 8,
						displayColors: false
					}
				},
				scales: {
					y: { grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#94a3b8', font: { size: 12 } } },
					x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } }
				}
			}
		});
	} else {
		chartHumBar.data.labels = labels;
		chartHumBar.data.datasets[0].data = avgHums;
		chartHumBar.update();
	}

	const ctxP = document.getElementById('barPres').getContext('2d');
	if (!chartPresBar) {
		chartPresBar = new Chart(ctxP, {
			type: 'bar',
			data: {
				labels,
				datasets: [{
					label: 'Avg Pressure (hPa)',
					data: avgPressures,
					backgroundColor: 'rgba(34, 197, 94, 0.8)',
					borderColor: 'rgba(34, 197, 94, 1)',
					borderWidth: 2,
					borderRadius: 6,
					borderSkipped: false,
					hoverBackgroundColor: 'rgba(34, 197, 94, 1)'
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: {
					legend: { display: false },
					tooltip: {
						backgroundColor: 'rgba(15, 23, 42, 0.95)',
						titleColor: '#f8fafc',
						bodyColor: '#cbd5e1',
						borderColor: 'rgba(34, 197, 94, 0.5)',
						borderWidth: 1,
						cornerRadius: 8,
						displayColors: false
					}
				},
				scales: {
					y: { grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#94a3b8', font: { size: 12 } } },
					x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } }
				}
			}
		});
	} else {
		chartPresBar.data.labels = labels;
		chartPresBar.data.datasets[0].data = avgPressures;
		chartPresBar.update();
	}

	const ctxR = document.getElementById('barRain').getContext('2d');
	if (!chartRainBar) {
		chartRainBar = new Chart(ctxR, {
			type: 'bar',
			data: {
				labels,
				datasets: [{
					label: 'Total Rainfall (mm)',
					data: totalRains,
					backgroundColor: 'rgba(96, 165, 250, 0.8)',
					borderColor: 'rgba(96, 165, 250, 1)',
					borderWidth: 2,
					borderRadius: 6,
					borderSkipped: false,
					hoverBackgroundColor: 'rgba(96, 165, 250, 1)'
				}]
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: {
					legend: { display: false },
					tooltip: {
						backgroundColor: 'rgba(15, 23, 42, 0.95)',
						titleColor: '#f8fafc',
						bodyColor: '#cbd5e1',
						borderColor: 'rgba(56, 189, 248, 0.5)',
						borderWidth: 1,
						cornerRadius: 8,
						displayColors: false
					}
				},
				scales: {
					y: { grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#94a3b8', font: { size: 12 } } },
					x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } }
				}
			}
		});
	} else {
		chartRainBar.data.labels = labels;
		chartRainBar.data.datasets[0].data = totalRains;
		chartRainBar.update();
	}

	if (usedFallback && rows.length === 0) {
		console.warn('loadCharts is displaying live-only chart data due to missing history');
	}
}

function buildDailySummariesFromHistory(days = 30) {
	const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
	const grouped = {};
	for (const item of recordedHistory) {
		if (!item || typeof item.timestamp !== 'number' || item.timestamp < cutoff) continue;
		const day = new Date(item.timestamp).toISOString().slice(0,10);
		if (!grouped[day]) {
			grouped[day] = { day, count: 0, sumTemp: 0, sumHum: 0, sumPres: 0, totalRain: 0 };
		}
		grouped[day].count += 1;
		grouped[day].sumTemp += Number.isFinite(item.temp) ? item.temp : 0;
		grouped[day].sumHum += Number.isFinite(item.hum) ? item.hum : 0;
		grouped[day].sumPres += Number.isFinite(item.pres) ? item.pres : 0;
		grouped[day].totalRain += Number.isFinite(item.rain) ? item.rain : 0;
	}

	const rows = Object.values(grouped).map(g => ({
		day: g.day,
		avg_temp: g.count ? g.sumTemp / g.count : 0,
		avg_hum: g.count ? g.sumHum / g.count : 0,
		avg_pres: g.count ? g.sumPres / g.count : 0,
		total_rain: g.totalRain
	}));
	rows.sort((a, b) => b.day.localeCompare(a.day));
	return rows.slice(0, days);
}

function updateChartsLive() {
	try {
		const todayLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

		const appendOrUpdate = (chart, value) => {
			if (!chart) return;
			const labels = chart.data.labels || [];
			const formattedValue = Number.isFinite(value) ? +value.toFixed(2) : 0;
			if (labels.length === 0 || labels[labels.length - 1] !== todayLabel) {
				chart.data.labels.push(todayLabel);
				chart.data.datasets[0].data.push(formattedValue);
			} else {
				chart.data.datasets[0].data[chart.data.datasets[0].data.length - 1] = formattedValue;
			}
			chart.update();
		};

		appendOrUpdate(chartTempBar, stationData.temp);
		appendOrUpdate(chartHumBar, stationData.hum);
		appendOrUpdate(chartPresBar, stationData.pres);
		appendOrUpdate(chartRainBar, stationData.rain);
	} catch (e) {
		// non-critical
	}
}

// --- PATCH: call updateChartsLive from updateUI so charts show live changes ---
const origUpdateUI = updateUI;
updateUI = function(data) {
	origUpdateUI(data);
	// keep charts in sync with latest live data
	updateChartsLive();
};

// --- NEW: build payload to send to server ---
function buildServerPayload() {
    return {
        timestamp: Date.now(),
        temp: Number.isFinite(stationData.temp) ? stationData.temp : null,
        hum: Number.isFinite(stationData.hum) ? stationData.hum : null,
        pres: Number.isFinite(stationData.pres) ? stationData.pres : null,
        rain: Number.isFinite(stationData.rain) ? stationData.rain : null,
        solarV: Number.isFinite(stationData.solarV) ? stationData.solarV : null,
        light: Number.isFinite(stationData.light) ? stationData.light : null,
        battery: Number.isFinite(stationData.batP) ? stationData.batP : null,
        wind: Number.isFinite(stationData.wind) ? stationData.wind : null,
        windDir: typeof stationData.windDir === 'number' ? getWindDirection(stationData.windDir) : null,
        windDirDeg: typeof stationData.windDir === 'number' ? stationData.windDir : null,
        lat: STATION_LAT,
        lon: STATION_LNG
    };
}

// --- NEW: post reading to backend (throttled) ---
async function postReading(payload) {
    try {
        const now = Date.now();
        if (now - lastPostTime < POST_INTERVAL_MS) return; // throttle
        lastPostTime = now;
        await fetch(`${API_ROOT}/data`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
    } catch (e) {
        // non-fatal, log for debugging
        console.warn('postReading failed', e);
    }
}

// Initialize everything when page loads
window.addEventListener('load', () => {
    console.log("KIU Dashboard initializing...");
    if (window.location.protocol === 'file:') {
        console.warn('Running from file://; API requests will be sent to http://localhost:3000/api. Start the server if you want chart/table/feedback support.');
    }
    
    // Initialize map first
    initMap();
    
    // Apply initial UI from stored data
    updateUI(stationData);
    
    // Start MQTT connection attempts
    setTimeout(() => {
        initMQTT();
    }, 500);
    
    // Set a timeout to start demo mode if MQTT never connects
    setTimeout(() => {
        if (!isConnected && !demoMode && connectionAttempts >= 6) {
            startDemoMode();
        }
    }, 15000);

    // Auto-refresh table and chart data every minute
    scheduleAutoRefresh();
});

// Manual refresh for map (useful for debugging)
window.refreshMap = () => {
    if (mapInstance) mapInstance.invalidateSize();
};

// Add manual toggle for demo mode (for testing)
window.toggleDemoMode = () => {
    if (demoMode) {
        demoMode = false;
        if (fallbackInterval) clearInterval(fallbackInterval);
        initMQTT();
    } else {
        startDemoMode();
        if (mqttClient && mqttClient.isConnected) {
            mqttClient.disconnect();
        }
    }
};

// Log helpful info to console
console.log("Dashboard loaded. Features:");
console.log("- Real-time environmental monitoring");
console.log("- Interactive map with KIU Kansanga location");
console.log("- Auto-reconnect MQTT with fallback ports");
console.log("- Demo mode with realistic data simulation");
console.log("- Local data persistence");