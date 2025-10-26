// --- Global Variables ---
let map;
let lineLayers = {};
let busLayers = {}; 
let isSimulating = false;
let offlineLines = new Set();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Color Definitions ---
const colors = {
    bus_ok: '#2196F3',
    bus_overloaded: '#F44336',
    line_green: '#4CAF50',
    line_orange: '#FF9800', 
    line_red: '#F44336',
    line_black: '#000000',
};

/**
 * Toggle a line on/off
 */
async function toggleLine(lineName) {
    try {
        const response = await fetch('/api/toggle-line', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ line_name: lineName })
        });
        const data = await response.json();
        
        if (data.status === 'offline') {
            offlineLines.add(lineName);
        } else {
            offlineLines.delete(lineName);
        }
        
        await updateDashboard(); // This will now rebuild the list
        
    } catch (error) {
        console.error("Error toggling line:", error);
    }
}

/**
 * Initialize the Leaflet map and draw base layers
 */
async function initMap() {
    map = L.map('map').setView([21.4389, -158.0001], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    try {
        const busesRes = await fetch('/api/map-buses');
        const busesData = await busesRes.json();
        
        busesData.forEach(d => {
            const latLng = [d.y, d.x]; 
            const busLayer = L.circleMarker(latLng, {
                radius: 5,
                fillColor: colors.bus_ok,
                color: '#000',
                weight: 1,
                opacity: 1,
                fillOpacity: 0.8
            }).bindPopup(`Bus: ${d.name}`);
            busLayer.addTo(map);
            busLayers[d.name] = busLayer;
        });

        const linesRes = await fetch('/api/map-lines');
        const linesData = await linesRes.json();
        
        L.geoJSON(linesData, {
            style: {
                color: colors.line_green,
                weight: 3
            },
            onEachFeature: (feature, layer) => {
                const lineName = feature.properties.Name;
                layer.bindPopup(`
                    <strong>Line: ${lineName}</strong><br>
                    <button onclick="toggleLine('${lineName}')" 
                            class="mt-2 bg-blue-500 text-white px-3 py-1 rounded text-sm">
                        Toggle On/Off
                    </button>
                `);
                
                layer.on('click', function(e) {
                    toggleLine(lineName);
                    L.DomEvent.stopPropagation(e);
                });
                
                layer.setStyle({ className: 'line-clickable' });
                lineLayers[lineName] = layer;
            }
        }).addTo(map);

        const legend = L.control({position: 'topright'}); 

        legend.onAdd = function (map) {
            const div = L.DomUtil.create('div', 'info legend');
            const lineColors = {
                [colors.line_green]: 'OK',
                [colors.line_orange]: 'Compromised (Near Overloaded Line)',
                [colors.line_red]: 'Overloaded',
                [colors.line_black]: 'Offline',
            };

            div.innerHTML = '<h4>Line Status</h4>'; 
            
            for (const color in lineColors) {
                div.innerHTML +=
                    '<i style="background:' + color + '"></i> ' + 
                    lineColors[color] + '<br>';
            }
            
            return div;
        };
        legend.addTo(map);

    } catch (error) {
        console.error("Error loading map data:", error);
        alert("Could not load map data from server.");
    }
}

/**
 * Main function to fetch data from backend and update UI
 * This is now a wrapper to prevent double-calls during simulation.
 */
async function updateDashboard() {
    if (isSimulating) return;
    await updateDashboardInternal();
}

/**
 * Runs the 24-hour simulation animation
 */
function run24hSim() {
    if (isSimulating) return;
    
    isSimulating = true;
    document.getElementById('sim-button').textContent = "Simulating...";
    document.getElementById('sim-button').disabled = true;

    let hour = 0;
    const simInterval = setInterval(async () => {
        if (hour > 24) {
            clearInterval(simInterval);
            isSimulating = false;
            document.getElementById('sim-button').textContent = "Run 24h Simulation";
            document.getElementById('sim-button').disabled = false;
            document.getElementById('sim-time').textContent = `Time: 00:00`;
            updateDashboard(); // Run one final, full refresh
            return;
        }

        const load_mult = 1.05 - 0.05 * Math.cos(hour * Math.PI / 12);
        
        document.getElementById('sim-time').textContent = `Time: ${String(hour).padStart(2, '0')}:00`;
        document.getElementById('load-slider').value = load_mult.toFixed(2);
        document.getElementById('load-value').textContent = load_mult.toFixed(2);
        document.getElementById('load-input').value = load_mult.toFixed(2);
        
        // --- THIS IS THE FIX ---
        // Call the core logic function directly to avoid the loading screen.
        await fetchAndApplyFullGridStatus(); 
        
        hour++;
    }, 500);
}

/**
 * Internal update function (wrapper) for manual updates.
 * This function *adds* the loading screen for user-initiated actions.
 */
async function updateDashboardInternal() {
     setLoading(true); // <-- Show loading overlay
     try {
         await fetchAndApplyFullGridStatus(); // <-- Run the actual update
     } catch (error) {
         console.error("Error in internal dashboard update:", error);
     } finally {
         setLoading(false); // <-- Hide loading overlay
     }
}

/**
 * NEW: Core update logic. Fetches data and applies it to the *entire* UI,
 * but does NOT trigger the loading overlay.
 * This is called directly by the simulation and by the wrapper function.
 */
async function fetchAndApplyFullGridStatus() {
     const temp = document.getElementById('temp-slider').value;
     const wind = document.getElementById('wind-slider').value;
     const load_mult = document.getElementById('load-slider').value;
     
     const mode = document.getElementById('report-mode-select').value;
     let n_param;
     let n_percent;
     let report_list_label;
     const top_n_val = document.getElementById('n-input').value;

     if (mode === 'top_n') {
         n_param = top_n_val;
         report_list_label = `Top ${n_param} Failing Lines`;
     } else { // mode === 'over_n'
         n_param = 999; 
         n_percent = parseFloat(document.getElementById('n-percent-input').value) || 0;
         report_list_label = `Lines Overloaded By ${n_percent}% or more`;
     }
     document.getElementById('report-list-label').textContent = report_list_label;

     try {
         // This endpoint uses the server's global 'offline_lines' state
         const url = `/api/grid-status?temp=${temp}&wind=${wind}&load_mult=${load_mult}&n=${n_param}`;
         const response = await fetch(url);
         const data = await response.json();
         
         // This is the *full* UI update function.
         applyFullGridStatusToUI(data, n_param, n_percent, mode);
    
     } catch (error) {
         console.error("Error in internal dashboard update:", error);
     }
}


/**
 * NEW: Applies a full grid status update to *all* UI elements.
 * Used by updateDashboardInternal().
 */
function applyFullGridStatusToUI(data, n_param, n_percent, mode) {
     offlineLines = new Set(data.offline_lines || []);
     document.getElementById('stress-score').textContent = data.report.overall_stress + "%";
     document.getElementById('offline-count').textContent = offlineLines.size;
     document.getElementById('overloaded-count').textContent = data.report.failure_count;
     document.getElementById('total-lines-count').textContent = data.report.total_lines;
     
     // --- LINE LIST POPULATION ---
     const lineListDiv = document.getElementById('line-list');
     lineListDiv.innerHTML = '';
     const lineNames = Object.keys(data.lines).sort((a, b) => {
         return parseInt(a.substring(1)) - parseInt(b.substring(1));
     });
     lineNames.forEach(lineName => {
         const lineData = data.lines[lineName];
         const isOffline = offlineLines.has(lineName);
         const status = isOffline ? 'offline' : 'online';
         let mvaString;
         if (isOffline) {
             mvaString = '(Offline)';
         } else if (lineData.rating_mva > 0) {
             mvaString = `(${lineData.current_mva} / ${lineData.rating_mva} MVA)`;
         } else {
             mvaString = '(Rating N/A)';
         }
         const lineItem = document.createElement('div');
         lineItem.className = 'line-item';
         lineItem.innerHTML = `
             <div class="flex flex-col">
                 <span class="font-mono text-sm font-semibold">${lineName}</span>
                 <span class="font-mono text-xs text-gray-500">${mvaString}</span>
             </div>
             <button 
                 class="status-badge status-${status}"
                 onclick="toggleLine('${lineName}')"
             >
                 ${status.toUpperCase()}
             </button>
         `;
         lineListDiv.appendChild(lineItem);
     });
     // --- END LINE LIST ---

     // --- REPORT POPULATION ---
     const reportList = document.getElementById('report-list');
     reportList.innerHTML = '';
     const all_failures = data.report.top_n_failures; 
     let failures_to_display;
     
     if (mode === 'top_n') {
         failures_to_display = all_failures; 
     } else { // mode === 'over_n'
         failures_to_display = all_failures.filter(line => line.loading >= n_percent);
         failures_to_display.sort((a, b) => b.loading - a.loading);
     }
     if (failures_to_display.length > 0) {
         failures_to_display.forEach(line => {
             const li = document.createElement('li');
             li.textContent = `${line.name} (${line.loading}% overloaded)`;
             reportList.appendChild(li);
         });
     } else {
         reportList.innerHTML = '<li>No failures detected.</li>';
     }
     // --- END REPORT ---
     
     // --- MAP UPDATE ---
     for (const busId in busLayers) {
         const color = data.buses[busId] === 'overloaded' ? colors.bus_overloaded : colors.bus_ok;
         busLayers[busId].setStyle({ fillColor: color });
     }
     for (const lineName in lineLayers) {
         const statusColorKey = data.lines[lineName]?.status_color;
         const color = colors['line_' + statusColorKey] || colors.line_black; 
         lineLayers[lineName].setStyle({ color: color, weight: 3 });
     }
     // --- END MAP UPDATE ---
}


/**
 * NEW: Applies a cascade round's data *only* to the map and global state.
 * This is a "lightweight" update used during the cascade simulation.
 */
function applyCascadeRoundToUI(data) {
    // This function *only* updates the map and global state
    // It does *not* update the reports or line list,
    // as that would be too slow/flickery during the simulation.
    
    // Update the *frontend* state to match what the simulation just ran
    offlineLines = new Set(data.offline_lines || []);
    
    // Update map buses
    for (const busId in busLayers) {
        const color = data.buses[busId] === 'overloaded' ? colors.bus_overloaded : colors.bus_ok;
        busLayers[busId].setStyle({ fillColor: color });
    }
    
    // Update map lines
    for (const lineName in lineLayers) {
        const statusColorKey = data.lines[lineName]?.status_color;
        const color = colors['line_' + statusColorKey] || colors.line_black; 
        lineLayers[lineName].setStyle({ color: color, weight: 3 });
    }
}


/**
 * Show/hide the loading overlay
 */
function setLoading(isLoading) {
    document.getElementById('loading-overlay').style.display = isLoading ? 'flex' : 'none';
}

/**
 * NEW: Toggles the report input UI
 */
function toggleReportMode() {
    const mode = document.getElementById('report-mode-select').value;
    const topNContainer = document.getElementById('top-n-container');
    const overNContainer = document.getElementById('over-n-container');

    if (mode === 'top_n') {
        topNContainer.style.display = 'block';
        overNContainer.style.display = 'none';
    } else { // mode === 'over_n'
        topNContainer.style.display = 'none';
        overNContainer.style.display = 'block';
    }
    
    updateDashboard(); 
}

/**
 * Run the 7-day forecast
 */
async function runForecast() {
    setLoading(true);
    const forecastButton = document.getElementById('forecast-button');
    forecastButton.textContent = 'Forecasting...';
    forecastButton.disabled = true;

    let forecastPayload = []; 
    
    try {
        const weatherApiUrl = "https://api.open-meteo.com/v1/forecast?latitude=21.3069&longitude=-157.8583&daily=temperature_2m_max,wind_speed_10m_max&forecast_days=7&timezone=Pacific%2FHonolulu";
        const weatherResponse = await fetch(weatherApiUrl);
        if (!weatherResponse.ok) {
            throw new Error(`Weather API failed: ${weatherResponse.statusText}`);
        }
        const weatherData = await weatherResponse.json();

        const kmh_to_fts = 0.911344;
        
        for (let i = 0; i < weatherData.daily.time.length; i++) {
            const date = new Date(weatherData.daily.time[i]);
            const day = date.toLocaleString('en-US', { weekday: 'short', timeZone: 'Pacific/Honolulu' });
            const temp = weatherData.daily.temperature_2m_max[i];
            const wind_kmh = weatherData.daily.wind_speed_10m_max[i];
            const wind_fts = wind_kmh * kmh_to_fts;
            const load_mult = 1.15;
            
            forecastPayload.push({
                day: day,
                temp: temp.toFixed(1),
                wind: wind_fts.toFixed(1),
                load: load_mult.toFixed(2)
            });
        }

        const response = await fetch('/api/predict', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(forecastPayload)
        });
        const predictions = await response.json();

        const forecastTableBody = document.getElementById('forecast-table-body');
        forecastTableBody.innerHTML = ''; 

        predictions.forEach((pred, index) => {
            const weather = forecastPayload[index]; 
            const row = document.createElement('tr');
            row.className = 'bg-white border-b';
            row.innerHTML = `
                <td class="py-2 px-2 font-medium text-gray-900">${weather.day}</td>
                <td class="py-2 px-2">${weather.temp}</td>
                <td class="py-2 px-2">${weather.wind}</td>
                <td class="py-2 px-2">${weather.load}</td>
                <td class="py-2 px-2 font-bold ${pred.predicted_failures > 0 ? 'text-red-600' : 'text-green-600'}">${pred.predicted_failures}</td>
                <td class="py-2 px-2 font-bold ${pred.predicted_stress > 10 ? 'text-red-600' : (pred.predicted_stress > 0 ? 'text-yellow-600' : 'text-green-600')}">${pred.predicted_stress}%</td>
            `;
            forecastTableBody.appendChild(row);
        });

    } catch (error) {
        console.error("Error running forecast:", error);
        alert(`Error running forecast: ${error.message}`);
        document.getElementById('forecast-table-body').innerHTML = `<tr><td colspan="6" class="text-center text-red-600 p-4">Could not load forecast data.</td></tr>`;
    } finally {
        setLoading(false);
        forecastButton.textContent = 'Run Weekly Forecast';
        forecastButton.disabled = false;
    }
}

/**
 * Finds the breakpoint for Temp/Wind using binary search
 */
async function findBreakpoint(variableToSearch) {
    setLoading(true);
    const tempBtn = document.getElementById('find-temp-breakpoint');
    const windBtn = document.getElementById('find-wind-breakpoint');
    const originalTempText = tempBtn.textContent;
    const originalWindText = windBtn.textContent;

    tempBtn.disabled = true;
    windBtn.disabled = true;
    const btnToUpdate = (variableToSearch === 'temp') ? tempBtn : windBtn;
    btnToUpdate.textContent = 'Searching...';

    const load_mult = document.getElementById('load-slider').value;
    let constantParams, searchRange, sliderId, inputId, valueId;

    if (variableToSearch === 'temp') {
        constantParams = { wind: document.getElementById('wind-slider').value, load_mult: load_mult };
        searchRange = { min: 0, max: 50, step: 0.1 };
        sliderId = 'temp-slider'; inputId = 'temp-input'; valueId = 'temp-value';
    } else { // 'wind'
        constantParams = { temp: document.getElementById('temp-slider').value, load_mult: load_mult };
        searchRange = { min: 0.5, max: 60, step: 0.1 };
        sliderId = 'wind-slider'; inputId = 'wind-input'; valueId = 'wind-value';
    }

    const checkValue = async (value) => {
        let temp, wind;
        if (variableToSearch === 'temp') { temp = value; wind = constantParams.wind; }
        else { temp = constantParams.temp; wind = value; }
        const url = `/api/grid-status?temp=${temp}&wind=${wind}&load_mult=${constantParams.load_mult}&n=1`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            return data.report.failure_count > 0; // True if failures exist
        } catch (e) { return false; }
    };

    let result;
    try {
        if (variableToSearch === 'temp') {
            if (!(await checkValue(searchRange.max))) {
                alert(`No failures found even at max ${variableToSearch} (${searchRange.max}).`); return;
            }
            if (await checkValue(searchRange.min)) {
                alert(`Failures already exist at min ${variableToSearch} (${searchRange.min}).`); return;
            }
            let low = searchRange.min, high = searchRange.max;
            while (high - low > 0.01) { 
                let mid = (low + high) / 2;
                if (await checkValue(mid)) { high = mid; } else { low = mid; }
            }
            result = high;
        } else { // 'wind'
            if (!(await checkValue(searchRange.min))) {
                alert(`No failures found even at min ${variableToSearch} (${searchRange.min}).`); return;
            }
            if (await checkValue(searchRange.max)) {
                alert(`Failures exist even at max ${variableToSearch} (${searchRange.max}).`); return;
            }
            let low = searchRange.min, high = searchRange.max;
            while (high - low > 0.01) {
                let mid = (low + high) / 2;
                if (await checkValue(mid)) { low = mid; } else { high = mid; }
            }
            result = high;
        }
    
        let finalResult;
        if (variableToSearch === 'temp') { finalResult = Math.ceil(result * 10) / 10; }
        else { finalResult = Math.floor(result * 10) / 10; }
        
        document.getElementById(sliderId).value = finalResult;
        document.getElementById(inputId).value = finalResult;
        document.getElementById(valueId).textContent = finalResult;
        
        await updateDashboard(); 

    } catch (error) {
        console.error("Error finding breakpoint:", error);
    } finally {
        setLoading(false);
        tempBtn.disabled = false; windBtn.disabled = false;
        tempBtn.textContent = originalTempText; windBtn.textContent = originalWindText;
    }
}

/**
 * Runs the N-1 Contingency Analysis
 */
async function runN1Analysis() {
    setLoading(true); // <-- This is OK, N-1 is a single, long-running task
    const btn = document.getElementById('n1-analysis-button');
    const originalText = btn.textContent;
    btn.textContent = 'Analyzing...';
    btn.disabled = true;
    const list = document.getElementById('n1-analysis-list');
    list.innerHTML = ''; 

    const temp = document.getElementById('temp-slider').value;
    const wind = document.getElementById('wind-slider').value;
    const load_mult = document.getElementById('load-slider').value;

    try {
        const url = `/api/n-1-analysis?temp=${temp}&wind=${wind}&load_mult=${load_mult}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Analysis failed: ${response.statusText}`);
        const data = await response.json();
        if (data.length === 0) {
            list.innerHTML = '<li class="text-gray-500 italic">No contingencies found.</li>';
            return;
        }
        data.forEach(item => {
            const li = document.createElement('li');
            li.innerHTML = `<strong>${item.line_name}</strong> (causes <strong>${item.failures_caused}</strong> failures)`;
            li.classList.add(item.failures_caused > 0 ? 'text-red-600' : 'text-green-600');
            list.appendChild(li);
        });
    } catch (error) {
        console.error("Error running N-1 Analysis:", error);
        list.innerHTML = `<li class="text-red-600">Error: ${error.message}</li>`;
    } finally {
        setLoading(false); // <-- This is OK
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

/**
 * Runs the Cascading Failure Analysis, round by round.
 */
async function runCascadeAnalysis() {
    // --- FIX 1: REMOVED setLoading(true) ---
    
    const btn = document.getElementById('cascade-analysis-button');
    const originalText = btn.textContent;
    btn.textContent = 'Simulating Cascade...';
    btn.disabled = true;

    const list = document.getElementById('n1-analysis-list');
    list.innerHTML = ''; // Clear previous results

    // 1. Save the user's original state
    const originalOfflineLines = new Set(offlineLines);
    let currentSimFailures = new Set(originalOfflineLines);
    const maxIterations = 10;
    let lastRoundFailed = false;

    try {
        // 3. Start the simulation loop
        for (let round = 0; round < maxIterations; round++) {
            const payload = {
                temp: document.getElementById('temp-slider').value,
                wind: document.getElementById('wind-slider').value,
                load_mult: document.getElementById('load-slider').value,
                current_offline_lines: Array.from(currentSimFailures)
            };
            
            // 4. Call the new single-round endpoint
            const response = await fetch('/api/cascade-round', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Analysis round ${round} failed: ${response.statusText}`);
            }
            const data = await response.json();
            
            // 5. Apply the result *only* to the map
            applyCascadeRoundToUI(data);

            // 6. Analyze results for this round
            const allFailuresThisRound = new Set(data.report.top_n_failures.map(f => f.name));
            
            // Find lines that failed *this* round (are in allFailures but not in our master list)
            const newFailures = new Set(
                [...allFailuresThisRound].filter(line => !currentSimFailures.has(line))
            );
            
            // 7. Log to the list
            const li = document.createElement('li');
            if (newFailures.size > 0) {
                li.innerHTML = `<strong>Round ${round}:</strong> ${Array.from(newFailures).join(', ')} failed.`;
                li.classList.add('text-red-600');
                lastRoundFailed = true;
            } else {
                li.innerHTML = `<strong>Round ${round}:</strong> Stable (No new failures).`;
                li.classList.add('text-green-600');
                lastRoundFailed = false;
                list.appendChild(li);
                break; // Stable, end the simulation
            }
            list.appendChild(li);

            // 8. Update state for *next* loop
            newFailures.forEach(line => currentSimFailures.add(line));
            
            // 9. Pause so the user can see the map change
            await sleep(1000); 
        }
        
        if (lastRoundFailed) {
             const li = document.createElement('li');
             li.innerHTML = `<strong>Cascade Unstable:</strong> Max iterations reached.`;
             li.classList.add('text-red-600', 'font-bold');
             list.appendChild(li);
        }

    } catch (error) {
        console.error("Error running Cascade Analysis:", error);
        list.innerHTML = `<li class="text-red-600">Error: ${error.message}</li>`;
    } finally {
        // 10. Restore original state
        const li = document.createElement('li');
        li.className = 'text-gray-500 italic mt-2';
        li.textContent = 'Simulation complete. Restoring original map state...';
        list.appendChild(li);
        
        await sleep(3000); // Wait 3 seconds
        
        // Restore the global frontend state
        offlineLines = originalOfflineLines;
        // And force a full UI refresh to match
        await updateDashboard();
        
        // --- FIX 2: This line is commented out to keep the results ---
        // list.innerHTML = '<li class="text-gray-500 italic">Run analysis to see results.</li>';
        
        // --- FIX 1: REMOVED setLoading(false) ---
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

/**
 * Runs the AI-driven Remediation Analysis
 * // --- MODIFIED ---
 */
async function runRemediationAnalysis() {
    const btn = document.getElementById('remediation-analysis-button');
    const originalText = btn.textContent;
    btn.textContent = 'Finding Plan...';
    btn.disabled = true;

    const list = document.getElementById('remediation-list');
    list.innerHTML = '<li class="text-gray-500 italic">Running GA...</li>';

    // --- NEW: Remove old "Apply" button if it exists ---
    const oldApplyBtn = document.getElementById('apply-remediation-btn');
    if (oldApplyBtn) {
        oldApplyBtn.remove();
    }
    // --- END NEW ---

    // 1. Get current grid state
    const payload = {
        temp: document.getElementById('temp-slider').value,
        wind: document.getElementById('wind-slider').value,
        load_mult: document.getElementById('load-slider').value,
        baseline_offline_lines: Array.from(offlineLines) // Use global frontend state
    };

    try {
        const response = await fetch('/api/find-remediation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`Server failed: ${response.statusText}`);
        }
        const data = await response.json();

        // 2. Render the results
        list.innerHTML = ''; // Clear "running" message
        
        const summary_li = document.createElement('li');
        summary_li.innerHTML = `<strong>Result:</strong> Failures reduced from <strong>${data.baseline_failures}</strong> to <strong class="font-bold ${data.remediated_failures > 0 ? 'text-red-600' : 'text-green-600'}">${data.remediated_failures}</strong>.`;
        list.appendChild(summary_li);
        
        const cost_li = document.createElement('li');
        cost_li.innerHTML = `<strong>Simulated Cost:</strong> ${data.cost} points.`;
        list.appendChild(cost_li);

        if (data.plan && data.plan.length > 0) {
            data.plan.forEach(action => {
                const li = document.createElement('li');
                li.textContent = `Action: ${action.desc}`;
                list.appendChild(li);
            });

            // --- NEW: Create and append the "Apply" button ---
            if (data.remediated_failures < data.baseline_failures || data.plan.some(a => a.type === 'CURTAIL')) {
                const applyBtn = document.createElement('button');
                applyBtn.id = 'apply-remediation-btn';
                applyBtn.className = 'w-full bg-teal-600 hover:bg-teal-800 text-white font-bold py-2 px-4 rounded mt-3';
                applyBtn.textContent = 'Apply This Remediation Plan';
                applyBtn.onclick = () => applyRemediationPlan(data.plan);
                
                // Append button *after* the list
                list.parentElement.appendChild(applyBtn);
            }
            // --- END NEW ---

        } else if (data.remediated_failures > 0) {
             const li = document.createElement('li');
             li.textContent = 'No viable remediation plan found.';
             li.classList.add('text-red-600', 'font-bold');
             list.appendChild(li);
        }

    } catch (error) {
        console.error("Error running Remediation Analysis:", error);
        list.innerHTML = `<li class="text-red-600">Error: ${error.message}</li>`;
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// --- NEW: Function to apply the plan ---
/**
 * Applies the selected remediation plan to the grid
 */
async function applyRemediationPlan(plan) {
    setLoading(true);
    try {
        let linesToReroute = [];
        let totalCurtailment = 0.0;

        for (const action of plan) {
            if (action.type === 'REROUTE') {
                linesToReroute.push(action.value);
            } else if (action.type === 'CURTAIL') {
                totalCurtailment += parseFloat(action.value);
            }
        }

        // 1. Apply Reroutes
        const reroutePromises = [];
        for (const lineName of linesToReroute) {
            // Only toggle if it's not *already* offline in the frontend state
            if (!offlineLines.has(lineName)) {
                const promise = fetch('/api/toggle-line', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ line_name: lineName })
                });
                reroutePromises.push(promise);
            }
        }
        
        // Wait for all backend toggles to complete
        if (reroutePromises.length > 0) {
            await Promise.all(reroutePromises);
        }

        // 2. Apply Load Curtailment
        if (totalCurtailment > 0) {
            const loadSlider = document.getElementById('load-slider');
            const loadInput = document.getElementById('load-input');
            const loadValue = document.getElementById('load-value');
            
            const currentLoad = parseFloat(loadSlider.value);
            const newLoad = Math.max(0.5, currentLoad - totalCurtailment); // 0.5 is min from index.html
            const finalLoadStr = newLoad.toFixed(2);
            
            // Manually update all UI elements for load
            loadSlider.value = finalLoadStr;
            loadInput.value = finalLoadStr;
            loadValue.textContent = finalLoadStr;
        }
        
        // 3. Force a single, full update to sync UI with new state
        // This will fetch the new grid status with the rerouted lines AND the new load value
        await updateDashboard(); 

        // 4. Remove the button now that the plan is applied
        const applyBtn = document.getElementById('apply-remediation-btn');
        if (applyBtn) {
            applyBtn.remove();
        }

    } catch (error) {
        console.error("Error applying remediation plan:", error);
        alert("An error occurred while applying the plan. Please check the console.");
    } finally {
        setLoading(false);
    }
}
// --- END NEW ---


// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', async () => {
    // --- THIS IS THE FIX: Wait for initMap() to finish before running updateDashboard() ---
    await initMap();
    await updateDashboard();

    // Slider listeners
    const tempSlider = document.getElementById('temp-slider');
    const windSlider = document.getElementById('wind-slider');
    const loadSlider = document.getElementById('load-slider');
    const loadInput = document.getElementById('load-input');
    const tempInput = document.getElementById('temp-input');
    const windInput = document.getElementById('wind-input');

    tempSlider.addEventListener('input', () => {
        const val = parseFloat(tempSlider.value).toFixed(1);
        document.getElementById('temp-value').textContent = val;
        tempInput.value = val;
    });
    tempSlider.addEventListener('change', updateDashboard);
    
    tempInput.addEventListener('input', () => {
        const val = parseFloat(tempInput.value).toFixed(1);
        document.getElementById('temp-value').textContent = val;
        tempSlider.value = val;
    });
    tempInput.addEventListener('change', updateDashboard);

    windSlider.addEventListener('input', () => {
        const val = parseFloat(windSlider.value).toFixed(1);
        document.getElementById('wind-value').textContent = val;
        windInput.value = val;
    });
    windSlider.addEventListener('change', updateDashboard);
    
    windInput.addEventListener('input', () => {
        const val = parseFloat(windInput.value).toFixed(1);
        document.getElementById('wind-value').textContent = val;
        windSlider.value = val;
    });
    windInput.addEventListener('change', updateDashboard);

    loadSlider.addEventListener('input', () => {
        const val = parseFloat(loadSlider.value).toFixed(2);
        document.getElementById('load-value').textContent = val;
        loadInput.value = val;
    });
    loadSlider.addEventListener('change', updateDashboard);
    
    loadInput.addEventListener('input', () => {
        const val = parseFloat(loadInput.value).toFixed(2);
        document.getElementById('load-value').textContent = val;
        loadSlider.value = val;
    });
    loadInput.addEventListener('change', updateDashboard);

    // Report Listeners
    document.getElementById('n-input').addEventListener('change', updateDashboard);
    document.getElementById('n-percent-input').addEventListener('change', updateDashboard);
    document.getElementById('report-mode-select').addEventListener('change', toggleReportMode);
    
    // Button listeners
    document.getElementById('sim-button').addEventListener('click', run24hSim);
    document.getElementById('forecast-button').addEventListener('click', runForecast);
    document.getElementById('find-temp-breakpoint').addEventListener('click', () => findBreakpoint('temp'));
    document.getElementById('find-wind-breakpoint').addEventListener('click', () => findBreakpoint('wind'));
    document.getElementById('n1-analysis-button').addEventListener('click', runN1Analysis);
    document.getElementById('cascade-analysis-button').addEventListener('click', runCascadeAnalysis);
    document.getElementById('remediation-analysis-button').addEventListener('click', runRemediationAnalysis);

    // --- ADDED FOR COLLAPSIBLE SECTIONS ---
    document.querySelectorAll('.collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
            // Find the content div, which is the *next sibling*
            const content = header.nextElementSibling;
            const icon = header.querySelector('.toggle-icon');

            if (content && content.classList.contains('collapsible-content')) {
                // Toggle the 'collapsed' class on the content
                content.classList.toggle('collapsed');
                
                // Update the icon and margin based on the new state
                if (content.classList.contains('collapsed')) {
                    icon.textContent = '[+]';
                    header.classList.remove('mb-4'); // No bottom margin if collapsed
                } else {
                    icon.textContent = '[-]';
                    header.classList.add('mb-4'); // Add bottom margin if expanded
                }
            }
        });
    });
    // --- END OF NEW BLOCK ---
});
