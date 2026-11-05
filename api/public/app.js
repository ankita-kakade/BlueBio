
const $ = selector => document.querySelector(selector);

const api = async url => {
    const response = await fetch(url);

    if (response.status === 401) {
        location.href = '/login.html';
        throw new Error('Please log in again.');
    }

    if (!response.ok) {
        throw new Error(`Request failed (${response.status}): ${url}`);
    }

    return response.json();
};

Chart.defaults.font.family = 'Inter, sans-serif';
Chart.defaults.color = '#3d6578';

let meta;
let map;
let layer = L.layerGroup();
let charts = {};
let cache = {};

const S = {
    region: 'mumbai',
    param: 'sst',
    m: 0
};

const fv = value => {
    if (value === null || value === undefined || value === '') {
        return '–';
    }

    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : '–';
};

const ramp = t => `hsl(${210 - 210 * t},75%,48%)`;

const fmt = (parameter, value) => {
    const unit = meta?.params?.[parameter]?.unit || '';
    return `${fv(value)} ${unit}`.trim();
};

function loadScript(src, test) {
    if (test()) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;

        script.onload = () => {
            if (test()) {
                resolve();
            } else {
                reject(new Error('Library loaded but was not initialized.'));
            }
        };

        script.onerror = () => {
            reject(new Error(`Could not load library: ${src}`));
        };

        document.head.appendChild(script);
    });
}

async function ensurePdfLibraries() {
    await loadScript(
        'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
        () => typeof window.html2pdf === 'function'
    );

    if (typeof window.html2canvas !== 'function') {
        await loadScript(
            'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
            () => typeof window.html2canvas === 'function'
        );
    }
}

function getFishCount(data) {
    const fish = data?.catch;

    if (!fish) {
        return null;
    }

    if (
        fish.fishTotal !== null &&
        fish.fishTotal !== undefined &&
        Number.isFinite(Number(fish.fishTotal))
    ) {
        return Math.max(0, Number(fish.fishTotal));
    }

    if (fish.species && typeof fish.species === 'object') {
        return Object.values(fish.species).reduce((total, value) => {
            const count = Number(value);
            return total + (Number.isFinite(count) ? count : 0);
        }, 0);
    }

    return null;
}

function setReportButtonBusy(button, busy, originalText) {
    button.disabled = busy;
    button.textContent = busy ? 'Generating PDF...' : originalText;
}


async function generatePDF() {
    const button = document.querySelector('#report');
    const originalText = button ? button.textContent : 'Generate PDF';
    let report = null;

    try {
        if (button) {
            button.disabled = true;
            button.textContent = 'Generating PDF...';
        }

        if (!meta) {
            throw new Error('Dashboard data is not loaded.');
        }

        if (typeof window.html2canvas !== 'function') {
            await loadScript(
                'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
                () => typeof window.html2canvas === 'function'
            );
        }

        if (!window.jspdf?.jsPDF) {
            await loadScript(
                'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
                () => Boolean(window.jspdf?.jsPDF)
            );
        }

        const regionName =
            meta.regions.find(r => r.id === S.region)?.name || S.region;
        const parameterName = meta.params[S.param]?.label || S.param;
        const monthName = meta.months[S.m];

        report = document.createElement('div');

        report.style.cssText = `
            display:block;
            position:fixed;
            top:0;
            left:0;
            width:760px;
            padding:32px;
            background:#ffffff;
            color:#183746;
            font-family:Arial,sans-serif;
            font-size:12px;
            line-height:1.5;
            z-index:2147483647;
            box-sizing:border-box;
        `;

        const safe = value => String(value ?? '–')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');

        report.innerHTML = `
            <div style="border-bottom:3px solid #0e7490;padding-bottom:16px">
                <p style="color:#0e7490;font-weight:bold;letter-spacing:2px">
                    MARINE RESEARCH PLATFORM
                </p>
                <h1 style="font-size:32px;color:#083344;margin:5px 0">BlueBio</h1>
                <h2 style="margin:0">Marine Data Analysis Report</h2>
                <p>Maharashtra Coastal Region</p>
            </div>

            <table style="width:100%;margin-top:20px;border-collapse:collapse">
                <tr>
                    <td style="padding:10px;background:#eef7f9">
                        <b>Coastal District</b><br>${safe(regionName)}
                    </td>
                    <td style="padding:10px;background:#eef7f9">
                        <b>Ocean Parameter</b><br>${safe(parameterName)}
                    </td>
                </tr>
                <tr>
                    <td style="padding:10px">
                        <b>Month</b><br>${safe(monthName)}
                    </td>
                    <td style="padding:10px">
                        <b>Generated</b><br>${new Date().toLocaleDateString()}
                    </td>
                </tr>
            </table>

            <h2 style="color:#083344;margin-top:25px">1. Oceanographic Summary</h2>
            <div id="pdf-summary"></div>

            <h2 style="color:#083344;margin-top:25px">2. Geographic Distribution</h2>
            <div id="pdf-map"></div>

            <h2 style="color:#083344;margin-top:25px">3. Ocean Trends and Fish Observations</h2>
            <div id="pdf-charts"></div>

            <h2 style="color:#083344;margin-top:25px">4. Anomaly Analysis</h2>
            <div id="pdf-anomalies"></div>

            <h2 style="color:#083344;margin-top:25px">5. Research Insights</h2>
            <div id="pdf-insights"></div>

            <footer style="margin-top:30px;border-top:1px solid #d6e5e9;padding-top:12px;font-size:10px">
                BlueBio | Integrated Marine Research Platform<br>
                Results reflect data currently available in the application.
            </footer>
        `;

        document.body.appendChild(report);

        const data = cache[S.region] ||
            await api('/api/region/' + encodeURIComponent(S.region));

        cache[S.region] = data;

        const summary = report.querySelector('#pdf-summary');
        const cards = document.createElement('div');

        cards.style.cssText =
            'display:grid;grid-template-columns:repeat(2,1fr);gap:10px';

        for (const [key, param] of Object.entries(meta.params)) {
            const value = data?.env?.[key]?.[S.m];

            const card = document.createElement('div');
            card.style.cssText =
                'border:1px solid #d6e5e9;padding:12px;background:#f5fafb';

            const label = document.createElement('div');
            label.textContent = param.label;

            const number = document.createElement('h2');
            number.textContent =
                value == null || !Number.isFinite(Number(value))
                    ? 'Unavailable'
                    : Number(value).toFixed(2);

            const unit = document.createElement('div');
            unit.textContent = param.unit || '';

            card.append(label, number, unit);
            cards.appendChild(card);
        }

        const fishCount = getFishCount(data);
        const fishCard = document.createElement('div');
        fishCard.style.cssText =
            'border:1px solid #d6e5e9;padding:12px;background:#f5fafb';
        fishCard.innerHTML = `
            <b>Fish records</b>
            <h2>${fishCount == null ? 'Unavailable' : safe(fishCount)}</h2>
            <div>District record count reported by the API</div>
        `;

        cards.appendChild(fishCard);
        summary.appendChild(cards);

        // Capture the map when possible.
        try {
            const mapElement = document.querySelector('#map');

            if (mapElement) {
                const mapCanvas = await window.html2canvas(mapElement, {
                    scale: 1,
                    useCORS: true,
                    backgroundColor: '#ffffff',
                    logging: false
                });

                const mapImage = document.createElement('img');
                mapImage.src = mapCanvas.toDataURL('image/jpeg', 0.85);
                mapImage.style.cssText = 'width:100%;height:auto;max-height:260px';

                report.querySelector('#pdf-map').appendChild(mapImage);
            }
        } catch (error) {
            console.warn('Map capture failed:', error);
            report.querySelector('#pdf-map').textContent =
                'Map image unavailable. Refer to the interactive dashboard.';
        }

        // Add dashboard charts as images.
        for (const [selector, title] of [
            ['#c1', 'Ocean Parameter Trend'],
            ['#c2', 'Fish Species Records'],
            ['#c3', 'Monthly Fish Observations']
        ]) {
            const chart = document.querySelector(selector);
            if (!chart) continue;

            try {
                const heading = document.createElement('h3');
                heading.textContent = title;

                const image = document.createElement('img');
                image.src = chart.toDataURL('image/png');
                image.style.cssText =
                    'display:block;width:100%;height:auto;max-height:260px;margin-bottom:15px';

                report.querySelector('#pdf-charts').append(heading, image);
            } catch (error) {
                console.warn('Chart capture failed:', selector, error);
            }
        }

        const anomalyTable = document.querySelector('#atable');

        if (anomalyTable) {
            const table = anomalyTable.cloneNode(true);
            table.style.cssText =
                'width:100%;border-collapse:collapse;font-size:10px';

            table.querySelectorAll('td,th').forEach(cell => {
                cell.style.cssText +=
                    'border:1px solid #d6e5e9;padding:6px;text-align:left';
            });

            report.querySelector('#pdf-anomalies').appendChild(table);
        }

        const insights = document.querySelector('#ins');

        if (insights) {
            report.querySelector('#pdf-insights').appendChild(
                insights.cloneNode(true)
            );
        }

        // Wait until the report and images have rendered.
        await new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
        );

        const canvas = await window.html2canvas(report, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: true,
            width: report.scrollWidth,
            height: report.scrollHeight,
            windowWidth: Math.max(window.innerWidth, report.scrollWidth),
            windowHeight: Math.max(window.innerHeight, report.scrollHeight),
            scrollX: 0,
            scrollY: 0
        });

        if (!canvas.width || !canvas.height) {
            throw new Error('The report canvas is empty.');
        }

        // Export the rendered canvas directly using jsPDF.
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');

        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const margin = 10;
        const usableWidth = pageWidth - margin * 2;
        const usableHeight = pageHeight - margin * 2;

        const scale = usableWidth / canvas.width;
        const pagePixelHeight = Math.floor(usableHeight / scale);

        let sourceY = 0;
        let pageNumber = 0;

        while (sourceY < canvas.height) {
            const sliceHeight = Math.min(
                pagePixelHeight,
                canvas.height - sourceY
            );

            const pageCanvas = document.createElement('canvas');
            pageCanvas.width = canvas.width;
            pageCanvas.height = sliceHeight;

            const context = pageCanvas.getContext('2d');

            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

            context.drawImage(
                canvas,
                0, sourceY, canvas.width, sliceHeight,
                0, 0, canvas.width, sliceHeight
            );

            if (pageNumber > 0) {
                pdf.addPage();
            }

            pdf.addImage(
                pageCanvas.toDataURL('image/jpeg', 0.95),
                'JPEG',
                margin,
                margin,
                usableWidth,
                sliceHeight * scale
            );

            sourceY += sliceHeight;
            pageNumber++;
        }

        if (pageNumber === 0) {
            throw new Error('No PDF pages were created.');
        }

        pdf.save('BlueBio_Marine_Research_Report.pdf');

    } catch (error) {
        console.error('PDF generation failed:', error);
        alert('PDF generation failed. Open F12 > Console and share the error.');
    } finally {
        if (report) report.remove();

        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}


async function init() {
    const logoutButton = $('#logout');

    if (logoutButton) {
        logoutButton.onclick = async () => {
            try {
                await fetch('/api/auth/logout', { method: 'POST' });
            } finally {
                location.href = '/login.html';
            }
        };
    }

    const reportButton = $('#report');

    if (reportButton) {
        reportButton.onclick = generatePDF;
    }

    try {
        const user = await fetch('/api/auth/me').then(response => response.json());

        if (user.name && $('#user')) {
            $('#user').textContent = user.name;
        }
    } catch (error) {
        console.warn('Could not load user information:', error);
    }

    try {
        meta = await api('/api/meta');
    } catch (error) {
        console.error('Metadata loading failed:', error);

        $('#kpis').innerHTML =
            '<div class="card wide">Could not load dashboard data. Check the API and refresh.</div>';

        return;
    }

    if (!meta.months?.length) {
        $('#kpis').innerHTML =
            '<div class="card wide">No data yet. Run the pipeline and reload.</div>';

        return;
    }

    if (!meta.regions?.length || !meta.params) {
        $('#kpis').innerHTML =
            '<div class="card wide">Region or parameter information is missing.</div>';

        return;
    }

    if (!meta.regions.some(region => region.id === S.region)) {
        S.region = meta.regions[0].id;
    }

    if (!meta.params[S.param]) {
        S.param = Object.keys(meta.params)[0];
    }

    S.m = meta.months.length - 1;

    $('#region').innerHTML = meta.regions.map(region =>
        `<option value="${region.id}">${region.name}</option>`
    ).join('');

    $('#params').innerHTML = Object.entries(meta.params).map(([key, value]) =>
        `<button type="button" data-p="${key}">${value.label}</button>`
    ).join('');

    $('#month').max = S.m;
    $('#month').value = S.m;

    map = L.map('map', {
        maxBounds: [[15.2, 71.6], [20.6, 74.6]],
        minZoom: 6
    }).setView([17.9, 73.0], 7);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    layer.addTo(map);

    api('/api/zones')
        .then(zones => {
            L.geoJSON(zones, {
                style: {
                    color: '#0e7490',
                    weight: 1,
                    fillOpacity: 0.06
                }
            }).addTo(map);
        })
        .catch(error => console.warn('Could not load zones:', error));

    $('#region').onchange = event => {
        S.region = event.target.value;
        refresh();
    };

    $('#month').oninput = event => {
        S.m = Number(event.target.value);
        refresh();
    };

    $('#params').onclick = event => {
        const parameter = event.target.dataset.p;

        if (parameter && meta.params[parameter]) {
            S.param = parameter;
            refresh();
        }
    };

    await refresh();
}

async function refresh() {
    if (!meta || !meta.params[S.param]) return;

    const parameter = meta.params[S.param];

    $('#region').value = S.region;
    $('#mlabel').textContent = meta.months[S.m];

    document.querySelectorAll('#params button').forEach(button => {
        button.classList.toggle('on', button.dataset.p === S.param);
    });

    try {
        const points = await api(
            `/api/map?m=${S.m}&param=${encodeURIComponent(S.param)}`
        );

        const validPoints = points.filter(point =>
            Number.isFinite(Number(point.value)) &&
            Number.isFinite(Number(point.lat)) &&
            Number.isFinite(Number(point.lon))
        );

        const values = validPoints.map(point => Number(point.value));
        const minimum = values.length ? Math.min(...values) : 0;
        const maximum = values.length ? Math.max(...values) : 0;

        $('#lmin').textContent = values.length ? minimum.toFixed(1) : '–';
        $('#lmax').textContent = values.length ? maximum.toFixed(1) : '–';

        layer.clearLayers();

        validPoints.forEach(point => {
            const value = Number(point.value);
            const intensity = maximum > minimum
                ? (value - minimum) / (maximum - minimum)
                : 0.5;

            if (point.anomaly) {
                L.marker([point.lat, point.lon], {
                    icon: L.divIcon({
                        className: '',
                        html: '<div class="ring"></div>',
                        iconSize: [34, 34],
                        iconAnchor: [17, 17]
                    }),
                    interactive: false
                }).addTo(layer);
            }

            L.circleMarker([point.lat, point.lon], {
                radius: 14,
                fillColor: ramp(intensity),
                fillOpacity: 0.9,
                color: point.id === S.region ? '#083344' : '#ffffff',
                weight: point.id === S.region ? 4 : 2
            })
                .bindTooltip(
                    `<b>${point.name}</b><br>${parameter.label}: ${fmt(S.param, value)}${point.anomaly ? '<br>Anomaly detected' : ''}`
                )
                .on('click', () => {
                    if (meta.regions.some(region => region.id === point.id)) {
                        S.region = point.id;
                        refresh();
                    }
                })
                .addTo(layer);
        });

        if (!cache[S.region]) {
            cache[S.region] = await api(
                '/api/region/' + encodeURIComponent(S.region)
            );
        }

        const data = cache[S.region];

        if (!data?.env || !data?.catch) {
            throw new Error('Regional API response is missing expected fields.');
        }

        const anomalies = data.anomalies || [];

        const parameterCards = Object.entries(meta.params).map(([key, value]) => {
            const hasAnomaly = anomalies.some(
                anomaly => anomaly.param === key &&
                    Number(anomaly.i) === S.m
            );

            return `
                <div class="kpi ${hasAnomaly ? 'bad' : ''}">
                    <small>${value.label}</small>
                    <b>${fv(data.env[key]?.[S.m])}</b>
                    <small>${value.unit || ''}${hasAnomaly ? ' · anomaly' : ''}</small>
                </div>
            `;
        }).join('');

        const totalFish = getFishCount(data);

        const fishCard = `
            <div class="kpi">
                <small>Fish records</small>
                <b>${totalFish === null ? 'Unavailable' : totalFish.toLocaleString()}</b>
                <small>records in this district</small>
            </div>
        `;

        $('#kpis').innerHTML = parameterCards + fishCard;

        const accent = '#0e7490';
        const parameterAnomalies = anomalies.filter(
            anomaly => anomaly.param === S.param
        );


        const makeChart = (selector, type, chartData, options = {}) => {
            const canvas = $(selector);

            if (!canvas) return;

            if (charts[selector]) {
                charts[selector].destroy();
            }

            charts[selector] = new Chart(canvas, {
                type,
                data: chartData,
                options: {
                    responsive: true,
                    plugins: {
                        legend: { display: false }
                    },
                    ...options
                }
            });
        };

        $('#t1').textContent =
            `${parameter.label} (${parameter.unit}) · ${meta.regions.find(region => region.id === S.region)?.name || S.region}`;

        const parameterValues = data.env[S.param] || [];


        makeChart('#c1', 'line', {
            labels: meta.months,
            datasets: [
                {
                    label: parameter.label,
                    data: parameterValues,
                    borderColor: accent,
                    backgroundColor: '#0e749022',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0
                },
                {
                    label: 'Anomalies',
                    data: parameterValues.map((value, index) =>
                        parameterAnomalies.some(
                            anomaly => Number(anomaly.i) === index
                        ) ? value : null
                    ),
                    showLine: false,
                    pointRadius: 7,
                    backgroundColor: '#c2410c'
                },
                {
                    label: 'Selected month',
                    data: parameterValues.map((value, index) =>
                        index === S.m ? value : null
                    ),
                    showLine: false,
                    pointRadius: 5,
                    backgroundColor: '#083344'
                }
            ]
        });

        const species = Object.entries(data.catch.species || {});

        makeChart('#c2', 'bar', {
            labels: species.map(item => item[0]),
            datasets: [{
                label: 'Records',
                data: species.map(item => Number(item[1]) || 0),
                backgroundColor: accent
            }]
        }, {
            indexAxis: 'y'
        });

       /* makeChart('#c3', 'line', {
            labels: meta.months,
            datasets: [{
                label: 'Fish observations',
                data: data.catch.total || [],
                borderColor: '#083344',
                tension: 0.3,
                pointRadius: 0
            }]
        });  */


        const selectedMonth = meta.months[S.m];
const selectedFishCount = data.catch.total?.[S.m] ?? 0;

makeChart('#c3', 'bar', {
    labels: [selectedMonth],
    datasets: [{
        label: 'Fish records',
        data: [selectedFishCount],
        backgroundColor: '#117a91',
        borderColor: '#083344',
        borderWidth: 1
    }]
});

        $('#atable').innerHTML =
            '<tr><th>Month</th><th>Parameter</th><th>Observed</th><th>Expected</th><th>Severity</th></tr>' +
            (anomalies.length
                ? anomalies.map(anomaly => `
                    <tr>
                        <td>${anomaly.month}</td>
                        <td>${meta.params[anomaly.param]?.label || anomaly.param}</td>
                        <td>${fmt(anomaly.param, anomaly.value)}</td>
                        <td>${fmt(anomaly.param, anomaly.expected)}</td>
                        <td>
                            <span class="tag ${anomaly.severity === 'High' ? 'h' : ''}">
                                ${anomaly.severity}
                            </span>
                        </td>
                    </tr>
                `).join('')
                : '<tr><td colspan="5">No anomalies found for this district.</td></tr>'
            );

        $('#ins').innerHTML = (data.insights || []).map(insight =>
            `<li class="${insight.type || ''}">${insight.text || ''}</li>`
        ).join('');

    } catch (error) {
        console.error('Dashboard refresh failed:', error);

        $('#kpis').innerHTML =
            '<div class="card wide">Could not load this district’s data. Check the browser Console and API response.</div>';
    }
}

init().catch(error => {
    console.error('Dashboard initialization failed:', error);
});
